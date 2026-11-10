import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ARTIFACTS, type Artifact, type Manifest } from "../archive/manifest.js";

/**
 * The SQLite ledger (P0-D3; PRD FR14c). DERIVED: every recording row is a pure
 * function of that recording's manifest (`rowFromManifest`), so `index rebuild`
 * reproduces the derived tables exactly. `runs` and `defects` are
 * observational run history and are deliberately not reproduced.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recordings (
  id            TEXT PRIMARY KEY,
  start_at      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  duration_ms   INTEGER,
  name          TEXT,
  serial_number TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  dir           TEXT NOT NULL,
  audio_state   TEXT NOT NULL CHECK (audio_state IN ('audio_pending','audio_ok','audio_failed')),
  audio_sha256  TEXT, audio_bytes INTEGER,
  audio_attempts INTEGER NOT NULL DEFAULT 0,
  audio_last_error TEXT,
  audio_next_retry_at TEXT,
  text_bundle_state TEXT NOT NULL CHECK (text_bundle_state IN
                  ('plaud_text_pending','plaud_text_ok','plaud_text_absent')),
  text_pending_since TEXT,
  manifest_rev  TEXT,
  manifest_hash TEXT
);
CREATE INDEX IF NOT EXISTS recordings_start_at ON recordings(start_at);
CREATE INDEX IF NOT EXISTS recordings_states   ON recordings(audio_state, text_bundle_state);

CREATE TABLE IF NOT EXISTS recording_artifacts (
  recording_id TEXT NOT NULL,
  artifact     TEXT NOT NULL CHECK (artifact IN ('transcript','polish','outline','highlights','note')),
  state        TEXT NOT NULL CHECK (state IN ('pending','present','absent')),
  last_checked_at TEXT,
  present_rev  TEXT,
  PRIMARY KEY (recording_id, artifact)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  window_from TEXT, window_to TEXT,
  listed INTEGER, new_ids INTEGER, audio_ok INTEGER, audio_failed INTEGER,
  text_resolved INTEGER, defects INTEGER, report_path TEXT
);

CREATE TABLE IF NOT EXISTS defects (
  run_id TEXT NOT NULL, id TEXT NOT NULL, start_at TEXT, created_at TEXT,
  noted_at TEXT NOT NULL, PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS sync_lag_samples (
  id TEXT PRIMARY KEY, start_at TEXT NOT NULL, created_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, lag_hours REAL NOT NULL
);
`;

export const DERIVED_TABLES = ["recordings", "recording_artifacts", "sync_lag_samples"] as const;

export interface RecordingRow {
  id: string;
  start_at: string;
  created_at: string;
  duration_ms: number | null;
  name: string | null;
  serial_number: string | null;
  first_seen_at: string;
  last_seen_at: string;
  dir: string;
  audio_state: string;
  audio_sha256: string | null;
  audio_bytes: number | null;
  audio_attempts: number;
  audio_last_error: string | null;
  audio_next_retry_at: string | null;
  text_bundle_state: string;
  text_pending_since: string | null;
  manifest_rev: string | null;
  manifest_hash: string | null;
}

export function rowFromManifest(m: Manifest, manifestHash: string | null): RecordingRow {
  return {
    id: m.id,
    start_at: m.startAt,
    created_at: m.createdAt,
    duration_ms: m.durationMs,
    name: m.name,
    serial_number: m.serialNumber,
    first_seen_at: m.firstSeenAt,
    last_seen_at: m.lastSeenAt,
    dir: m.dir,
    audio_state: m.states.audio.state,
    audio_sha256: m.audio?.sha256 ?? null,
    audio_bytes: m.audio?.bytes ?? null,
    audio_attempts: m.states.audio.attempts,
    audio_last_error: m.states.audio.lastErrorClass,
    audio_next_retry_at: m.states.audio.nextRetryAt,
    text_bundle_state: m.states.textBundle,
    text_pending_since: m.states.textPendingSince,
    manifest_rev: m.current.rev,
    manifest_hash: manifestHash,
  };
}

/** Hours between two ISO instants (b − a). */
export function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000;
}

export class Ledger {
  readonly db: Database.Database;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    if (opts.readonly) {
      // For --dry-run / report: never creates or migrates anything.
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Re-derive a recording's rows from its manifest (the authority). */
  upsertFromManifest(m: Manifest, manifestHash: string | null): void {
    const row = rowFromManifest(m, manifestHash);
    const cols = Object.keys(row);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO recordings (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})
           ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(",")}`,
        )
        .run(row);
      const art = this.db.prepare(
        `INSERT INTO recording_artifacts (recording_id, artifact, state, last_checked_at, present_rev)
         VALUES (?,?,?,?,?) ON CONFLICT(recording_id, artifact) DO UPDATE SET
         state=excluded.state, last_checked_at=excluded.last_checked_at, present_rev=excluded.present_rev`,
      );
      for (const a of ARTIFACTS) {
        const s = m.states.artifacts[a];
        art.run(m.id, a, s.state, s.lastCheckedAt, s.presentRev);
      }
      this.db
        .prepare(
          `INSERT INTO sync_lag_samples (id, start_at, created_at, first_seen_at, lag_hours) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at, created_at=excluded.created_at,
           first_seen_at=excluded.first_seen_at, lag_hours=excluded.lag_hours`,
        )
        .run(m.id, m.startAt, m.createdAt, m.firstSeenAt, hoursBetween(m.startAt, m.firstSeenAt));
    });
    tx();
  }

  /** Exclude a recording from the index (e.g. it is corrupt). */
  remove(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM recordings WHERE id=?").run(id);
      this.db.prepare("DELETE FROM recording_artifacts WHERE recording_id=?").run(id);
      this.db.prepare("DELETE FROM sync_lag_samples WHERE id=?").run(id);
    });
    tx();
  }

  get(id: string): RecordingRow | undefined {
    return this.db.prepare("SELECT * FROM recordings WHERE id=?").get(id) as RecordingRow | undefined;
  }

  byDir(dir: string): RecordingRow | undefined {
    return this.db.prepare("SELECT * FROM recordings WHERE dir=?").get(dir) as RecordingRow | undefined;
  }

  allIds(): Set<string> {
    return new Set((this.db.prepare("SELECT id FROM recordings").all() as { id: string }[]).map((r) => r.id));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM recordings").get() as { n: number }).n;
  }

  maxStartAt(): string | null {
    return (this.db.prepare("SELECT MAX(start_at) m FROM recordings").get() as { m: string | null }).m;
  }

  /** audio_pending ∪ (audio_failed where next_retry_at ≤ now), oldest start_at first. */
  audioDue(now: Date): RecordingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM recordings WHERE audio_state='audio_pending'
           OR (audio_state='audio_failed' AND (audio_next_retry_at IS NULL OR audio_next_retry_at <= ?))
         ORDER BY start_at ASC`,
      )
      .all(now.toISOString()) as RecordingRow[];
  }

  /** Every pending bundle regardless of age (R2-2), oldest text_pending_since first. */
  textPending(limit: number): RecordingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM recordings WHERE text_bundle_state='plaud_text_pending'
         ORDER BY text_pending_since ASC, start_at ASC LIMIT ?`,
      )
      .all(limit) as RecordingRow[];
  }

  artifacts(id: string): Record<Artifact, string> {
    const rows = this.db.prepare("SELECT artifact, state FROM recording_artifacts WHERE recording_id=?").all(id) as {
      artifact: Artifact;
      state: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.artifact, r.state])) as Record<Artifact, string>;
  }

  // --- observational ---------------------------------------------------------

  startRun(id: string, kind: string, startedAt: string): void {
    this.db.prepare("INSERT INTO runs (id, kind, started_at) VALUES (?,?,?)").run(id, kind, startedAt);
  }

  finishRun(id: string, f: Record<string, string | number | null>): void {
    const cols = Object.keys(f);
    this.db.prepare(`UPDATE runs SET ${cols.map((c) => `${c}=@${c}`).join(",")} WHERE id=@id`).run({ ...f, id });
  }

  addDefect(runId: string, id: string, startAt: string | null, createdAt: string | null, notedAt: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO defects (run_id, id, start_at, created_at, noted_at) VALUES (?,?,?,?,?)")
      .run(runId, id, startAt, createdAt, notedAt);
  }

  /** Deterministic dump of the derived tables, for the identical-after-rebuild check. */
  dumpDerived(): string {
    const order: Record<string, string> = {
      recordings: "id",
      recording_artifacts: "recording_id, artifact",
      sync_lag_samples: "id",
    };
    return DERIVED_TABLES.map((t) => {
      const rows = this.db.prepare(`SELECT * FROM ${t} ORDER BY ${order[t]}`).all();
      return `-- ${t}\n` + rows.map((r) => JSON.stringify(r)).join("\n");
    }).join("\n");
  }

  clearDerived(): void {
    const tx = this.db.transaction(() => {
      for (const t of DERIVED_TABLES) this.db.exec(`DELETE FROM ${t}`);
    });
    tx();
  }
}
