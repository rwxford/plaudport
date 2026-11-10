import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { absDir, AUDIO, ledgerPath } from "./archive/layout.js";
import { Ledger } from "./ledger/db.js";

/**
 * `plaudport report` (PRD FR22, partial; P0-PLAN T9 and §7 "§13 defaults P0
 * installs"). Read-only over the ledger: state totals, retry escalation, error
 * classes, the last run, and — with `--lag` — the sync-lag readout that will
 * replace the 14-day overlap default with evidence. Redacted by default: counts,
 * states and error classes only; ids appear only when redaction is off.
 */

export interface Percentiles {
  n: number;
  max: number | null;
  p95: number | null;
  median: number | null;
}

export function percentiles(values: number[]): Percentiles {
  if (!values.length) return { n: 0, max: null, p95: null, median: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { n: s.length, max: s[s.length - 1]!, p95: at(0.95), median: at(0.5) };
}

export interface Report {
  recordings: number;
  audio: Record<string, number>;
  textBundle: Record<string, number>;
  artifacts: Record<string, Record<string, number>>;
  attemptsHistogram: Record<string, number>;
  errorClasses: Record<string, number>;
  escalated: { threshold: number; count: number; ids?: string[] };
  lastRun: null | {
    kind: string;
    startedAt: string;
    finishedAt: string | null;
    listed: number | null;
    newIds: number | null;
    defects: number | null;
    requests: number | null;
    rateLimited: number | null;
  };
  lag?: {
    firstSeenMinusStartHours: Percentiles;
    createdMinusStartHours: Percentiles;
    impliedOverlapDays: number | null;
    configuredOverlapDays: number;
    textResolutionHours: Percentiles;
    configuredTextTimeoutDays: number;
    note: string;
  };
  audioVerify?: { sampled: number; ok: number; mismatched: number; missing: number };
}

const countBy = (rows: { k: string | number | null; n: number }[]) =>
  Object.fromEntries(rows.map((r) => [String(r.k), r.n])) as Record<string, number>;

export async function buildReport(
  root: string,
  opts: {
    lag?: boolean;
    verifyAudio?: number;
    revealIds?: boolean;
    retryReportAfter: number;
    overlapDays: number;
    textTimeoutDays: number;
    rand?: () => number;
  },
): Promise<Report | null> {
  if (!existsSync(ledgerPath(root))) return null;
  const l = new Ledger(ledgerPath(root), { readonly: true });
  try {
    const q = <T>(sql: string, ...a: unknown[]) => l.db.prepare(sql).all(...a) as T[];
    const artRows = q<{ artifact: string; state: string; n: number }>(
      "SELECT artifact, state, COUNT(*) n FROM recording_artifacts GROUP BY artifact, state",
    );
    const artifacts: Report["artifacts"] = {};
    for (const r of artRows) (artifacts[r.artifact] ??= {})[r.state] = r.n;

    const esc = q<{ id: string }>("SELECT id FROM recordings WHERE audio_attempts >= ? AND audio_state != 'audio_ok' ORDER BY id", opts.retryReportAfter);

    const run = q<Record<string, string | number | null>>("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1")[0];
    let lastRun: Report["lastRun"] = null;
    if (run) {
      let requests: number | null = null;
      let rateLimited: number | null = null;
      if (typeof run.report_path === "string" && existsSync(run.report_path)) {
        try {
          const j = JSON.parse(readFileSync(run.report_path, "utf8")) as { source?: { requests: number; rateLimited: number } };
          requests = j.source?.requests ?? null;
          rateLimited = j.source?.rateLimited ?? null;
        } catch {
          /* report file unreadable: counts unknown */
        }
      }
      lastRun = {
        kind: String(run.kind),
        startedAt: String(run.started_at),
        finishedAt: (run.finished_at as string | null) ?? null,
        listed: run.listed as number | null,
        newIds: run.new_ids as number | null,
        defects: run.defects as number | null,
        requests,
        rateLimited,
      };
    }

    const rep: Report = {
      recordings: l.count(),
      audio: countBy(q("SELECT audio_state k, COUNT(*) n FROM recordings GROUP BY audio_state")),
      textBundle: countBy(q("SELECT text_bundle_state k, COUNT(*) n FROM recordings GROUP BY text_bundle_state")),
      artifacts,
      attemptsHistogram: countBy(q("SELECT audio_attempts k, COUNT(*) n FROM recordings GROUP BY audio_attempts ORDER BY audio_attempts")),
      errorClasses: countBy(q("SELECT audio_last_error k, COUNT(*) n FROM recordings WHERE audio_last_error IS NOT NULL GROUP BY audio_last_error")),
      escalated: { threshold: opts.retryReportAfter, count: esc.length, ...(opts.revealIds ? { ids: esc.map((e) => e.id) } : {}) },
      lastRun,
    };

    if (opts.lag) {
      const lags = q<{ start_at: string; created_at: string; lag_hours: number }>("SELECT start_at, created_at, lag_hours FROM sync_lag_samples");
      const firstSeen = percentiles(lags.map((r) => r.lag_hours));
      const created = percentiles(lags.map((r) => (Date.parse(r.created_at) - Date.parse(r.start_at)) / 3_600_000));
      // Time from pending to the last artifact that arrived, for resolved bundles.
      const res = q<{ since: string; last: string | null }>(
        `SELECT r.text_pending_since since, MAX(a.last_checked_at) last FROM recordings r
         JOIN recording_artifacts a ON a.recording_id = r.id AND a.state = 'present'
         WHERE r.text_bundle_state = 'plaud_text_ok' AND r.text_pending_since IS NOT NULL GROUP BY r.id`,
      );
      const resolution = percentiles(res.filter((r) => r.last).map((r) => (Date.parse(r.last!) - Date.parse(r.since)) / 3_600_000));
      // The §13 rule: overlap = 2 × the longest observed gap between recording
      // and appearing in Plaud. first-seen − start is inflated by backfills
      // (an --all run "first sees" year-old recordings), so the implied window
      // uses Plaud's own created_at − start_at; both are printed.
      const maxGap = created.max ?? -Infinity;
      rep.lag = {
        firstSeenMinusStartHours: firstSeen,
        createdMinusStartHours: created,
        impliedOverlapDays: Number.isFinite(maxGap) ? Math.max(1, Math.ceil((2 * maxGap) / 24)) : null,
        configuredOverlapDays: opts.overlapDays,
        textResolutionHours: resolution,
        configuredTextTimeoutDays: opts.textTimeoutDays,
        note: "Calibration (class c): the overlap default stays pending until 30 days of samples or P6, whichever is first (P0-PLAN §7).",
      };
    }

    if (opts.verifyAudio && opts.verifyAudio > 0) {
      const ok = q<{ dir: string; audio_sha256: string }>("SELECT dir, audio_sha256 FROM recordings WHERE audio_state='audio_ok'");
      const rand = opts.rand ?? Math.random;
      const sample = [...ok].sort(() => rand() - 0.5).slice(0, opts.verifyAudio);
      const v = { sampled: sample.length, ok: 0, mismatched: 0, missing: 0 };
      for (const r of sample) {
        const p = join(absDir(root, r.dir), AUDIO);
        if (!existsSync(p)) {
          v.missing++;
          continue;
        }
        (await sha256File(p)) === r.audio_sha256 ? v.ok++ : v.mismatched++;
      }
      rep.audioVerify = v;
    }
    return rep;
  } finally {
    l.close();
  }
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

const fmt = (p: Percentiles, unit = "h") =>
  p.n ? `n=${p.n}, median ${p.median!.toFixed(1)}${unit}, p95 ${p.p95!.toFixed(1)}${unit}, max ${p.max!.toFixed(1)}${unit}` : "no samples yet";

export function renderReport(r: Report): string {
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
  const lines = [
    `Recordings in the archive: ${r.recordings}`,
    `  audio: ${kv(r.audio)}`,
    `  Plaud text bundles: ${kv(r.textBundle)}`,
    ...Object.entries(r.artifacts).map(([a, s]) => `    ${a}: ${kv(s)}`),
    `  download attempts: ${Object.entries(r.attemptsHistogram).map(([k, v]) => `${k}× ${v}`).join(", ") || "—"}`,
    `  last error classes: ${kv(r.errorClasses)}`,
    `  failing ≥ ${r.escalated.threshold} times: ${r.escalated.count}${r.escalated.ids ? ` (${r.escalated.ids.join(", ")})` : ""}`,
  ];
  if (r.lastRun) {
    const lr = r.lastRun;
    lines.push(
      `Last run: ${lr.kind} at ${lr.startedAt} — listed ${lr.listed ?? "?"}, new ${lr.newIds ?? "?"}, defects ${lr.defects ?? "?"}, ` +
        `${lr.requests ?? "?"} request(s), ${lr.rateLimited ?? "?"} rate-limited`,
    );
  }
  if (r.lag) {
    lines.push(
      "Sync lag (§13 overlap window calibration):",
      `  first seen − start_at: ${fmt(r.lag.firstSeenMinusStartHours)}`,
      `  Plaud created_at − start_at: ${fmt(r.lag.createdMinusStartHours)}`,
      `  implied overlap (2 × max): ${r.lag.impliedOverlapDays ?? "—"} day(s); configured ${r.lag.configuredOverlapDays}`,
      `  Plaud text, pending → last artifact: ${fmt(r.lag.textResolutionHours)}; timeout ${r.lag.configuredTextTimeoutDays} day(s)`,
      `  ${r.lag.note}`,
    );
  }
  if (r.audioVerify) {
    const v = r.audioVerify;
    lines.push(`Audio re-verification: ${v.ok}/${v.sampled} match${v.mismatched ? `, ${v.mismatched} MISMATCHED` : ""}${v.missing ? `, ${v.missing} MISSING` : ""}`);
  }
  return lines.join("\n");
}
