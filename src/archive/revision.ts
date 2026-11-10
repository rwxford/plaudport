import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  fsyncDir,
  fsyncFile,
  mkdirOne,
  mkdirsDurable,
  removeTree,
  renameDurable,
  setFsHook,
  writeFileAtomic,
  type FsOp,
} from "./fsx.js";
import { absDir, AUDIO, MANIFEST, META, revName, revNumber, STATE_DIR } from "./layout.js";
import {
  parseManifest,
  serializeManifest,
  type Artifact,
  type ArtifactStatus,
  type AudioStatus,
  type Manifest,
  type RevEntry,
} from "./manifest.js";

export { setFsHook, type FsOp };

/**
 * The archive write/read protocol (PRD FR14b/FR14c; P0-PLAN §6), implemented
 * once and used by every writer. Callers MUST hold the archive lock (lock.ts)
 * for every function here that mutates the disk.
 *
 * fsync ordering is the crash-safety contract:
 *   revision:  each file (temp → fsync → rename) → each nested dir → rev.tmp
 *              → rename rev.tmp → rev → fsync recording dir
 *   manifest:  manifest.json.tmp → fsync → rename → fsync recording dir
 *   new dirs:  each newly-created dir and its parent, up to an existing ancestor
 *   audio:     .part → fsync → rename → fsync recording dir, BEFORE the
 *              manifest that records its hash
 */

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export type RevisionFiles = Record<string, string | Buffer>;

/** Fields of a recording that come from Plaud's listing. */
export interface RecordingFacts {
  id: string;
  startAt: string;
  createdAt: string;
  durationMs: number | null;
  name: string | null;
  serialNumber: string | null;
}

/** What `meta.json` holds: Plaud's facts + PlaudPort's observations (C1). */
export interface MetaDoc extends RecordingFacts {
  schema: 2;
  dir: string;
  writtenAt: string;
  listing: unknown;
  detail: unknown | null;
  observed: {
    firstSeenAt: string;
    lastSeenAt: string;
    audio: AudioStatus;
    textPendingSince: string | null;
    artifacts: Record<Artifact, ArtifactStatus>;
  };
}

// --- revisions --------------------------------------------------------------

function committedRevs(recDir: string): number[] {
  if (!existsSync(recDir)) return [];
  return readdirSync(recDir)
    .map((n) => revNumber(n))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

/**
 * The next revision name: one past the highest COMMITTED rev dir (referenced
 * or not), so debris from a crashed writer is never reused. Deterministic
 * under the archive lock, so a caller may learn it before writing.
 */
export function allocateRev(recDir: string): string {
  return revName((committedRevs(recDir).at(-1) ?? 0) + 1);
}

/**
 * Write a new immutable revision directory and return its manifest entry. The
 * manifest is NOT touched; the revision is invisible until `commitManifest`.
 */
export function writeRevision(recDir: string, files: RevisionFiles, now: Date, rev: string = allocateRev(recDir)): RevEntry {
  if (rev !== allocateRev(recDir)) throw new Error("revision name is not the next free one");
  const tmp = join(recDir, `${rev}.tmp`);
  // Under the lock no other writer exists, so a same-named .tmp is debris.
  if (existsSync(tmp)) removeTree(tmp);
  mkdirOne(tmp);

  const artifacts: Record<string, string> = {};
  const subdirs = new Set<string>();
  for (const rel of Object.keys(files).sort()) {
    if (rel.includes("..") || rel.startsWith("/")) throw new Error("artifact path escapes the revision");
    const parts = rel.split("/");
    let d = tmp;
    for (const p of parts.slice(0, -1)) {
      d = join(d, p);
      if (!subdirs.has(d)) {
        mkdirOne(d);
        subdirs.add(d);
      }
    }
    const data = files[rel]!;
    writeFileAtomic(join(tmp, ...parts), data);
    artifacts[rel] = sha256(data);
  }
  // Nested dirs deepest first, then the revision dir itself.
  for (const d of [...subdirs].sort((a, b) => b.length - a.length)) fsyncDir(d);
  fsyncDir(tmp);
  renameDurable(tmp, join(recDir, rev));
  fsyncDir(recDir);
  return { rev, writtenAt: now.toISOString(), artifacts };
}

/** Atomically replace manifest.json and make the rename durable. */
export function commitManifest(recDir: string, m: Manifest): void {
  writeFileAtomic(join(recDir, MANIFEST), serializeManifest(m));
  fsyncDir(recDir);
}

/** New manifest pointing at `entry`; history trimmed in the same swap. */
export function withRevision(m: Manifest, entry: RevEntry, historyLimit: number): Manifest {
  return { ...m, current: entry, history: [m.current, ...m.history].slice(0, historyLimit) };
}

/**
 * Make a verified `audio.mp3.part` the recording's audio, THEN commit the
 * manifest that records its hash — so a manifest never references audio that
 * is not durably on disk.
 */
export function commitAudio(recDir: string, partPath: string, m: Manifest): void {
  fsyncFile(partPath);
  renameDurable(partPath, join(recDir, AUDIO));
  fsyncDir(recDir);
  commitManifest(recDir, m);
}

// --- discovery (step 0) ------------------------------------------------------

export interface InitInput {
  facts: RecordingFacts;
  rel: string;
  listing: unknown;
  now: Date;
  audio: AudioStatus;
  artifacts: Record<Artifact, ArtifactStatus>;
}

export function buildMeta(
  facts: RecordingFacts,
  rel: string,
  listing: unknown,
  detail: unknown | null,
  observed: MetaDoc["observed"],
  now: Date,
): MetaDoc {
  return { schema: 2, ...facts, dir: rel, writtenAt: now.toISOString(), listing, detail, observed };
}

function manifestFromMeta(meta: MetaDoc, entry: RevEntry): Manifest {
  return {
    schema: 2,
    id: meta.id,
    dir: meta.dir,
    startAt: meta.startAt,
    createdAt: meta.createdAt,
    durationMs: meta.durationMs,
    name: meta.name,
    serialNumber: meta.serialNumber,
    audio: null,
    current: entry,
    history: [],
    firstSeenAt: meta.observed.firstSeenAt,
    lastSeenAt: meta.observed.lastSeenAt,
    states: {
      audio: meta.observed.audio,
      textBundle: "plaud_text_pending",
      textPendingSince: meta.observed.textPendingSince,
      artifacts: meta.observed.artifacts,
    },
  };
}

/**
 * Initialize a never-seen recording: durable path, rev-0001/meta.json, then
 * the initial manifest — all BEFORE any download (C1, R2-4).
 */
export function initializeRecording(root: string, input: InitInput): Manifest {
  const recDir = absDir(root, input.rel);
  mkdirsDurable(recDir, root);
  const at = input.now.toISOString();
  const meta = buildMeta(
    input.facts,
    input.rel,
    input.listing,
    null,
    { firstSeenAt: at, lastSeenAt: at, audio: input.audio, textPendingSince: at, artifacts: input.artifacts },
    input.now,
  );
  const entry = writeRevision(recDir, { [META]: JSON.stringify(meta, null, 2) + "\n" }, input.now);
  const m = manifestFromMeta(meta, entry);
  commitManifest(recDir, m);
  return m;
}

/**
 * A recording dir with no committed manifest is an INTERRUPTED initialization
 * (R3-2), never "corrupt". Complete it from rev-0001/meta.json (no network); if
 * there is no committed meta.json the dir carries no information and is
 * removed, to be re-created when the id is next listed.
 */
export function completeInterruptedInit(recDir: string): { kind: "completed"; manifest: Manifest } | { kind: "removed" } {
  const metaPath = join(recDir, revName(1), META);
  if (existsSync(metaPath)) {
    const raw = readFileSync(metaPath);
    const meta = JSON.parse(raw.toString("utf8")) as MetaDoc;
    // Hash every file that rev-0001 holds (P0: just meta.json).
    const entry: RevEntry = {
      rev: revName(1),
      writtenAt: meta.writtenAt,
      artifacts: listRevisionFiles(join(recDir, revName(1))),
    };
    const m = manifestFromMeta(meta, entry);
    commitManifest(recDir, m);
    return { kind: "completed", manifest: m };
  }
  removeTree(recDir);
  fsyncDir(dirname(recDir));
  return { kind: "removed" };
}

function listRevisionFiles(revDir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ent of readdirSync(revDir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) Object.assign(out, listRevisionFiles(join(revDir, ent.name), rel));
    else if (!ent.name.endsWith(".tmp")) out[rel] = sha256(readFileSync(join(revDir, ent.name)));
  }
  return out;
}

// --- read protocol -----------------------------------------------------------

export type ReadResult =
  | { status: "ok"; manifest: Manifest; rev: RevEntry; fellBack: boolean }
  | { status: "no-manifest" }
  | { status: "corrupt"; reason: string };

function verifyRev(recDir: string, entry: RevEntry): boolean {
  for (const [rel, hash] of Object.entries(entry.artifacts)) {
    const p = join(recDir, entry.rev, ...rel.split("/"));
    if (!existsSync(p)) return false;
    if (sha256(readFileSync(p)) !== hash) return false;
  }
  return true;
}

/**
 * Load and verify a recording: `current` first, then each `history` entry. A
 * parseable manifest whose every revision fails verification is CORRUPT and is
 * reported, never silently repaired.
 */
export function readRecording(recDir: string): ReadResult {
  const mp = join(recDir, MANIFEST);
  if (!existsSync(mp)) return { status: "no-manifest" };
  let m: Manifest;
  try {
    m = parseManifest(readFileSync(mp, "utf8"));
  } catch {
    return { status: "corrupt", reason: "manifest-unparseable" };
  }
  if (verifyRev(recDir, m.current)) return { status: "ok", manifest: m, rev: m.current, fellBack: false };
  for (const h of m.history) {
    if (verifyRev(recDir, h)) return { status: "ok", manifest: m, rev: h, fellBack: true };
  }
  return { status: "corrupt", reason: "no-revision-verifies" };
}

export function readRevisionFile(recDir: string, entry: RevEntry, rel: string): Buffer | null {
  if (!(rel in entry.artifacts)) return null;
  const p = join(recDir, entry.rev, ...rel.split("/"));
  return existsSync(p) ? readFileSync(p) : null;
}

/** All files of a verified revision, for carrying forward into the next one. */
export function readRevisionFiles(recDir: string, entry: RevEntry): RevisionFiles {
  const out: RevisionFiles = {};
  for (const rel of Object.keys(entry.artifacts)) {
    const b = readRevisionFile(recDir, entry, rel);
    if (b) out[rel] = b;
  }
  return out;
}

// --- cleanup (step 4) --------------------------------------------------------

const TMP_MAX_AGE_MS = 60 * 60_000;

/**
 * Delete revision dirs in neither `current` nor `history`, and `*.tmp` debris
 * older than an hour. Only ever called under the archive lock.
 */
export function cleanupRecording(recDir: string, m: Manifest, now: Date): string[] {
  const keep = new Set([m.current.rev, ...m.history.map((h) => h.rev)]);
  const removed: string[] = [];
  for (const name of readdirSync(recDir)) {
    const p = join(recDir, name);
    if (revNumber(name) !== null && !keep.has(name)) {
      removeTree(p);
      removed.push(name);
    } else if (name.endsWith(".tmp") || name.endsWith(".part")) {
      if (name === `${AUDIO}.part`) continue; // owned by the download step
      const age = now.getTime() - statSync(p).mtimeMs;
      if (age > TMP_MAX_AGE_MS) {
        removeTree(p);
        removed.push(name);
      }
    }
  }
  if (removed.length) fsyncDir(recDir);
  return removed;
}

// --- enumeration -------------------------------------------------------------

/** Every `<YYYY>/<MM>/<id>` directory under the root, as relative paths. */
export function listRecordingDirs(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const y of readdirSync(root)) {
    if (y === STATE_DIR || !/^\d{4}$/.test(y)) continue;
    const yd = join(root, y);
    if (!statSync(yd).isDirectory()) continue;
    for (const mo of readdirSync(yd)) {
      if (!/^\d{2}$/.test(mo)) continue;
      const md = join(yd, mo);
      if (!statSync(md).isDirectory()) continue;
      for (const id of readdirSync(md)) {
        if (statSync(join(md, id)).isDirectory()) out.push(`${y}/${mo}/${id}`);
      }
    }
  }
  return out.sort();
}
