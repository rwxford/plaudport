import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "../config.js";
import { AUDIO, absDir, ledgerPath, META, recordingRelDir, reportsDir } from "../archive/layout.js";
import { ArchiveLock } from "../archive/lock.js";
import { ARTIFACT_FILE, ARTIFACTS, type Artifact, type Manifest } from "../archive/manifest.js";
import {
  allocateRev,
  buildMeta,
  cleanupRecording,
  commitAudio,
  commitManifest,
  completeInterruptedInit,
  initializeRecording,
  readRecording,
  readRevisionFile,
  readRevisionFiles,
  sha256,
  withRevision,
  writeRevision,
  type MetaDoc,
  type RevisionFiles,
} from "../archive/revision.js";
import { Ledger } from "../ledger/db.js";
import { sweepArchive, type SweepResult } from "../ledger/sweep.js";
import { AuthError, type PlaudText, type RecordingDetail, type RecordingSource, type RecordingSummary } from "../sources/types.js";
import { DownloadError, downloadToPart } from "./download.js";
import {
  applyTextCheck,
  DAY_MS,
  deriveBundle,
  initialArtifacts,
  initialAudio,
  nextAudio,
  pastTextDeadline,
  reopenAbsent,
  urlNeedsRefresh,
} from "./states.js";

/**
 * `plaudport pull` (PRD FR1, FR1a–d, FR3; P0-PLAN §7).
 *
 *   0  take the OS archive lock (exit 3 if busy)
 *   0b startup reconcile of EVERY recording dir (manifest is authority)
 *   1  window: overlap from the newest known recording, or --since/--until/--all
 *   2  list every page; manifest-first discovery write for each id BEFORE any download
 *   3  audio for audio_pending ∪ due audio_failed, oldest first
 *   4  text for every pending bundle regardless of age, capped, oldest first
 *   5  run row + redacted JSON report
 */

export const EXIT = { ok: 0, defects: 2, busy: 3, auth: 4, error: 1 } as const;
const PAGE_SIZE = 100;
const EPOCH = "1970-01-01";
const LAST_SEEN_REFRESH_MS = 3_600_000;

export interface PullOptions {
  since?: string;
  until?: string;
  all?: boolean;
  reconcile?: boolean;
  dryRun?: boolean;
  /** Reopen absent artifacts for these ids, or for every recording. */
  recheckText?: string[] | "all";
}

export interface PullDeps {
  cfg: PipelineConfig;
  openSource: () => Promise<RecordingSource>;
  isAllowedHost: (host: string) => boolean;
  now?: () => Date;
  rand?: () => number;
  log?: (line: string) => void;
  /** Show ids in the report/log (only when PLAUD_REDACT_SAMPLES=false). */
  revealIds?: boolean;
  downloadIdleTimeoutMs?: number;
}

export interface PullReport {
  run: { id: string; kind: "pull" | "reconcile"; startedAt: string; finishedAt: string; window: { from: string; to: string } | null; dryRun: boolean };
  listed: number;
  pages: number;
  newIds: number;
  adopted: number;
  corrupt: number;
  audio: { attempted: number; ok: number; failed: number; urlRefreshed: number };
  text: { checked: number; newlyPresent: number; agedOut: number; resolved: number; errors: number };
  defects: number;
  errors: Record<string, number>;
  source: { requests: number; rateLimited: number; retries: number };
  sweep: Omit<SweepResult, "corrupt" | "fellBack"> & { corrupt: number; fellBack: number };
  /** Ids only when redaction is off. */
  samples?: { defects: string[]; newIds: string[] };
  outcome: "ok" | "busy" | "auth" | "error";
  note?: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => day(new Date(Date.parse(ymd + "T00:00:00Z") + n * DAY_MS));

export function computeWindow(
  opts: Pick<PullOptions, "since" | "until" | "all" | "reconcile">,
  maxStartAt: string | null,
  overlapDays: number,
  now: Date,
): { from: string; to: string } {
  // An explicit --until is an exact inclusive bound (G2 compares one day with
  // the web UI); otherwise one day of slack past today (F6).
  const to = opts.until ?? addDays(day(now), 1);
  let from: string;
  if (opts.all || opts.reconcile) from = EPOCH;
  else if (opts.since) from = opts.since;
  else if (maxStartAt) from = addDays(day(new Date(maxStartAt)), -overlapDays - 1);
  else from = addDays(day(now), -overlapDays);
  return { from, to };
}

function blank(runId: string, kind: "pull" | "reconcile", startedAt: string, dryRun: boolean): PullReport {
  return {
    run: { id: runId, kind, startedAt, finishedAt: startedAt, window: null, dryRun },
    listed: 0,
    pages: 0,
    newIds: 0,
    adopted: 0,
    corrupt: 0,
    audio: { attempted: 0, ok: 0, failed: 0, urlRefreshed: 0 },
    text: { checked: 0, newlyPresent: 0, agedOut: 0, resolved: 0, errors: 0 },
    defects: 0,
    errors: {},
    source: { requests: 0, rateLimited: 0, retries: 0 },
    sweep: { scanned: 0, rederived: 0, completed: 0, removed: 0, corrupt: 0, fellBack: 0, cleaned: 0 },
    outcome: "ok",
  };
}

/** Which Plaud artifacts does a text fetch show as present / final-empty? */
export function observe(t: PlaudText): Partial<Record<Artifact, boolean | "absent">> {
  const b = (name: string) => t.transcript.find((x) => x.block === name);
  const has = (name: string) => (b(name)?.items.length ?? 0) > 0;
  const hl = b("mark_memo");
  const noteHas = (t.note ?? []).some((n) => {
    if (n && typeof n === "object") {
      const c = (n as Record<string, unknown>).data_content;
      return typeof c === "string" ? c.trim().length > 0 : Object.keys(n).length > 0;
    }
    return typeof n === "string" ? n.trim().length > 0 : n !== null && n !== undefined;
  });
  return {
    transcript: has("transaction"),
    polish: has("transaction_polish"),
    outline: has("outline"),
    highlights: hl?.items.length ? true : hl?.status === "empty" ? "absent" : false,
    note: noteHas,
  };
}

function artifactBody(t: PlaudText, a: Artifact): string {
  const block = { transcript: "transaction", polish: "transaction_polish", outline: "outline", highlights: "mark_memo" } as const;
  const body = a === "note" ? t.note ?? [] : t.transcript.find((x) => x.block === block[a])?.items ?? [];
  return JSON.stringify(body, null, 2) + "\n";
}

export async function runPull(opts: PullOptions, deps: PullDeps): Promise<{ exitCode: number; report: PullReport }> {
  const now = deps.now ?? (() => new Date());
  const rand = deps.rand ?? Math.random;
  const log = deps.log ?? ((l: string) => console.log(l));
  const cfg = deps.cfg;
  const root = cfg.archiveRoot;
  const t0 = now();
  const kind = opts.reconcile ? "reconcile" : "pull";
  const runId = `${kind}-${t0.toISOString().replace(/[-:.]/g, "")}-${randomBytes(2).toString("hex")}`;
  const report = blank(runId, kind, t0.toISOString(), !!opts.dryRun);
  const bump = (cls: string) => (report.errors[cls] = (report.errors[cls] ?? 0) + 1);
  const defectIds: string[] = [];
  const newIdList: string[] = [];

  // --- dry run: list and count, write nothing ---------------------------------
  if (opts.dryRun) {
    const ledger = existsSync(ledgerPath(root)) ? new Ledger(ledgerPath(root), { readonly: true }) : null;
    const known = ledger?.allIds() ?? new Set<string>();
    const window = computeWindow(opts, ledger?.maxStartAt() ?? null, cfg.overlapDays, t0);
    ledger?.close();
    report.run.window = window;
    const source = await deps.openSource();
    try {
      for (let page = 1; ; page++) {
        const items = await source.list(window, { page, pageSize: PAGE_SIZE });
        report.pages++;
        report.listed += items.length;
        for (const it of items) if (!known.has(it.id)) report.newIds++;
        if (items.length < PAGE_SIZE) break;
      }
    } catch (e) {
      report.outcome = e instanceof AuthError ? "auth" : "error";
      report.note = e instanceof AuthError ? e.message : `listing failed (${(e as { errorClass?: string }).errorClass ?? "error"})`;
    } finally {
      report.source = source.stats();
      await source.close();
    }
    report.run.finishedAt = now().toISOString();
    log(`dry run: ${report.listed} listed over ${report.pages} page(s), ${report.newIds} not yet in the archive (window ${window.from} → ${window.to})`);
    return { exitCode: report.outcome === "auth" ? EXIT.auth : report.outcome === "error" ? EXIT.error : EXIT.ok, report };
  }

  // --- 0. lock ---------------------------------------------------------------------
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = ArchiveLock.tryAcquire(root, t0);
  if (!lock) {
    report.outcome = "busy";
    report.note = "archive busy: another PlaudPort process holds the archive lock";
    log(report.note);
    return { exitCode: EXIT.busy, report };
  }
  const ledger = new Ledger(ledgerPath(root));
  ledger.startRun(runId, kind, t0.toISOString());
  let source: RecordingSource | null = null;
  try {
    // --- 0b. startup reconcile --------------------------------------------------
    const sw = sweepArchive(root, ledger, lock, { now: t0 });
    report.sweep = { ...sw, corrupt: sw.corrupt.length, fellBack: sw.fellBack.length };
    if (sw.corrupt.length) log(`warning: ${sw.corrupt.length} corrupt recording(s) excluded from the index (see report)`);
    if (sw.fellBack.length) log(`warning: manifest-mismatch on ${sw.fellBack.length} recording(s); using the previous revision`);

    // --recheck-text: reopen absent artifacts before selection.
    if (opts.recheckText) {
      const ids = opts.recheckText === "all" ? [...ledger.allIds()] : opts.recheckText;
      for (const id of ids) {
        const row = ledger.get(id);
        if (!row) continue;
        const dir = absDir(root, row.dir);
        const r = readRecording(dir);
        if (r.status !== "ok") continue;
        const arts = reopenAbsent(r.manifest.states.artifacts);
        const bundle = deriveBundle(arts);
        if (bundle === r.manifest.states.textBundle && bundle !== "plaud_text_pending") continue;
        const m: Manifest = { ...r.manifest, states: { ...r.manifest.states, artifacts: arts, textBundle: bundle, textPendingSince: t0.toISOString() } };
        commitManifest(dir, m);
        ledger.upsertFromManifest(m, sha256(readFileSync(join(dir, "manifest.json"))));
      }
    }

    source = await deps.openSource();

    // --- 1. window ----------------------------------------------------------------
    const window = computeWindow(opts, ledger.maxStartAt(), cfg.overlapDays, t0);
    report.run.window = window;
    const knownAtStart = ledger.allIds();

    // --- 2. discovery, manifest-first ----------------------------------------------
    for (let page = 1; page < 100_000; page++) {
      const items = await source.list(window, { page, pageSize: PAGE_SIZE });
      report.pages++;
      report.listed += items.length;
      for (const it of items) {
        const isNew = !knownAtStart.has(it.id);
        if (isNew && opts.reconcile) {
          report.defects++;
          defectIds.push(it.id);
          ledger.addDefect(runId, it.id, it.startAt, it.createdAt, t0.toISOString());
        }
        const outcome = discover(root, ledger, it, now());
        if (outcome === "corrupt") report.corrupt++;
        else if (outcome === "initialized") {
          report.newIds++;
          newIdList.push(it.id);
        } else report.adopted++;
      }
      if (items.length < PAGE_SIZE) break;
    }
    if (report.defects) log(`WARN discovery defect: ${report.defects} recording(s) in Plaud were missing from the ledger (FR1d); now archived`);

    // --- 3. audio ----------------------------------------------------------------------
    const detailCache = new Map<string, RecordingDetail>();
    for (const row of ledger.audioDue(now())) {
      report.audio.attempted++;
      const dir = absDir(root, row.dir);
      const r = readRecording(dir);
      if (r.status !== "ok") continue;
      const res = await fetchAudio(source, row.id, dir, deps, cfg, now, report);
      let m = r.manifest;
      if (res.ok) {
        if (res.detail) detailCache.set(row.id, res.detail);
        m = {
          ...m,
          audio: { file: AUDIO, bytes: res.bytes, sha256: res.sha256, fetchedAt: now().toISOString() },
          states: { ...m.states, audio: nextAudio(m.states.audio, { kind: "download_ok" }, now(), rand()) },
        };
        commitAudio(dir, join(dir, `${AUDIO}.part`), m);
        report.audio.ok++;
      } else {
        bump(res.errorClass);
        m = { ...m, states: { ...m.states, audio: nextAudio(m.states.audio, { kind: "download_failed", errorClass: res.errorClass }, now(), rand()) } };
        commitManifest(dir, m);
        report.audio.failed++;
      }
      ledger.upsertFromManifest(m, sha256(readFileSync(join(dir, "manifest.json"))));
    }

    // --- 4. Plaud text, per artifact ---------------------------------------------------
    for (const row of ledger.textPending(cfg.textChecksPerRun)) {
      const dir = absDir(root, row.dir);
      const r = readRecording(dir);
      if (r.status !== "ok") continue;
      let m = r.manifest;
      const at = now();
      if (pastTextDeadline(m.states.textPendingSince, at, cfg.textTimeoutDays)) {
        const arts = applyTextCheck(m.states.artifacts, { pastDeadline: true }, at);
        report.text.agedOut++;
        m = { ...m, states: { ...m.states, artifacts: arts, textBundle: deriveBundle(arts) } };
      } else {
        report.text.checked++;
        let t: PlaudText;
        try {
          t = await source.text(row.id);
        } catch (e) {
          if (e instanceof AuthError) throw e;
          report.text.errors++;
          bump((e as { errorClass?: string }).errorClass ?? "text_error");
          continue;
        }
        const seen = observe(t);
        const fresh = ARTIFACTS.filter((a) => m.states.artifacts[a].state === "pending" && seen[a] === true);
        let presentRev: string | null = null;
        if (fresh.length) {
          const files: RevisionFiles = readRevisionFiles(dir, r.rev);
          const prevMeta = readMeta(dir, r.rev);
          for (const a of fresh) files[ARTIFACT_FILE[a]] = artifactBody(t, a);
          const nextRevName = allocateRev(dir);
          const arts = applyTextCheck(m.states.artifacts, { pastDeadline: false, observed: seen, presentRev: nextRevName }, at);
          const meta = buildMeta(
            factsOf(m),
            m.dir,
            prevMeta?.listing ?? null,
            detailCache.get(row.id)?.rawDetail ?? prevMeta?.detail ?? null,
            { firstSeenAt: m.firstSeenAt, lastSeenAt: m.lastSeenAt, audio: m.states.audio, textPendingSince: m.states.textPendingSince, artifacts: arts },
            at,
          );
          files[META] = JSON.stringify(meta, null, 2) + "\n";
          const entry = writeRevision(dir, files, at, nextRevName);
          presentRev = entry.rev;
          m = withRevision({ ...m, states: { ...m.states, artifacts: arts, textBundle: deriveBundle(arts) } }, entry, cfg.revisionHistory);
          report.text.newlyPresent += fresh.length;
        } else {
          const arts = applyTextCheck(m.states.artifacts, { pastDeadline: false, observed: seen, presentRev }, at);
          m = { ...m, states: { ...m.states, artifacts: arts, textBundle: deriveBundle(arts) } };
        }
      }
      commitManifest(dir, m);
      cleanupRecording(dir, m, at);
      if (m.states.textBundle !== "plaud_text_pending") report.text.resolved++;
      ledger.upsertFromManifest(m, sha256(readFileSync(join(dir, "manifest.json"))));
    }
  } catch (e) {
    if (e instanceof AuthError) {
      report.outcome = "auth";
      report.note = e.message;
    } else {
      report.outcome = "error";
      report.note = `pull failed (${(e as { errorClass?: string }).errorClass ?? (e as Error).name})`;
      bump((e as { errorClass?: string }).errorClass ?? "internal");
      if (process.env.PLAUDPORT_DEBUG === "1") console.error(e);
    }
    log(report.note);
  } finally {
    if (source) {
      report.source = source.stats();
      await source.close();
    }
    report.run.finishedAt = now().toISOString();
    if (deps.revealIds) report.samples = { defects: defectIds, newIds: newIdList };
    const reportPath = writeReport(root, report);
    ledger.finishRun(runId, {
      finished_at: report.run.finishedAt,
      window_from: report.run.window?.from ?? null,
      window_to: report.run.window?.to ?? null,
      listed: report.listed,
      new_ids: report.newIds,
      audio_ok: report.audio.ok,
      audio_failed: report.audio.failed,
      text_resolved: report.text.resolved,
      defects: report.defects,
      report_path: reportPath,
    });
    ledger.close();
    lock.release();
  }

  log(
    `${kind}: listed ${report.listed} (${report.pages} page(s)), new ${report.newIds}, ` +
      `audio ${report.audio.ok} ok / ${report.audio.failed} failed, ` +
      `text +${report.text.newlyPresent} artifact(s), ${report.text.resolved} bundle(s) resolved` +
      (report.defects ? `, ${report.defects} DEFECT(S)` : "") +
      ` · ${report.source.requests} request(s), ${report.source.rateLimited} rate-limited`,
  );
  const exitCode =
    report.outcome === "auth" ? EXIT.auth : report.outcome === "error" ? EXIT.error : report.defects > 0 ? EXIT.defects : EXIT.ok;
  return { exitCode, report };
}

// --- helpers ------------------------------------------------------------------------

function factsOf(m: Manifest) {
  return { id: m.id, startAt: m.startAt, createdAt: m.createdAt, durationMs: m.durationMs, name: m.name, serialNumber: m.serialNumber };
}

function readMeta(dir: string, rev: { rev: string; artifacts: Record<string, string> }): MetaDoc | null {
  const b = readRevisionFile(dir, rev as never, META);
  if (!b) return null;
  try {
    return JSON.parse(b.toString("utf8")) as MetaDoc;
  } catch {
    return null;
  }
}

/** §6 step 0 for one listed item. */
function discover(root: string, ledger: Ledger, it: RecordingSummary, at: Date): "initialized" | "adopted" | "corrupt" {
  const row = ledger.get(it.id);
  const rel = row?.dir ?? recordingRelDir(it.id, it.startAt);
  const dir = absDir(root, rel);
  const facts = { id: it.id, startAt: it.startAt, createdAt: it.createdAt, durationMs: it.durationMs, name: it.name, serialNumber: it.serialNumber };

  if (existsSync(dir)) {
    let r = readRecording(dir);
    if (r.status === "no-manifest") {
      const done = completeInterruptedInit(dir); // from meta.json, or removed if empty
      if (done.kind === "removed") return init();
      r = readRecording(dir);
    }
    if (r.status === "corrupt") return "corrupt";
    if (r.status !== "ok") return init();
    // Adopt: never re-initialize. Refresh Plaud's mutable facts (e.g. a late AI
    // title) and last-seen, as a manifest-only swap.
    let m = r.manifest;
    const changed = m.name !== it.name || m.durationMs !== it.durationMs || m.createdAt !== it.createdAt;
    const stale = at.getTime() - Date.parse(m.lastSeenAt) >= LAST_SEEN_REFRESH_MS;
    if (changed || stale) {
      m = { ...m, name: it.name, durationMs: it.durationMs, createdAt: it.createdAt, lastSeenAt: at.toISOString() };
      commitManifest(dir, m);
    }
    ledger.upsertFromManifest(m, sha256(readFileSync(join(dir, "manifest.json"))));
    return "adopted";
  }
  return init();

  function init(): "initialized" {
    const m = initializeRecording(root, { facts, rel, listing: it.raw, now: at, audio: initialAudio(), artifacts: initialArtifacts() });
    ledger.upsertFromManifest(m, sha256(readFileSync(join(dir, "manifest.json"))));
    return "initialized";
  }
}

type AudioResult = { ok: true; bytes: number; sha256: string; detail: RecordingDetail | null } | { ok: false; errorClass: string };

/**
 * One download attempt, with FR1c's expired-URL rule: a URL older than 23 h,
 * or one S3 rejects with 403, is re-fetched once and is NOT an attempt. Only a
 * failure with a fresh URL counts.
 */
async function fetchAudio(
  source: RecordingSource,
  id: string,
  dir: string,
  deps: PullDeps,
  cfg: PipelineConfig,
  now: () => Date,
  report: PullReport,
): Promise<AudioResult> {
  let detail: RecordingDetail;
  try {
    detail = await source.detail(id);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return { ok: false, errorClass: (e as { errorClass?: string }).errorClass ?? "detail_error" };
  }
  let refreshed = false;
  const refresh = async (): Promise<boolean> => {
    if (refreshed) return false;
    refreshed = true;
    report.audio.urlRefreshed++;
    try {
      detail = await source.detail(id);
      return true;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      return false;
    }
  };
  if (detail.audioUrl && urlNeedsRefresh(detail.audioUrlIssuedAt, now(), cfg.debugUrlAgeHours)) {
    if (!(await refresh())) return { ok: false, errorClass: "detail_error" };
  }
  for (;;) {
    if (!detail.audioUrl) return { ok: false, errorClass: "no_audio_url" };
    try {
      const r = await downloadToPart(detail.audioUrl, join(dir, `${AUDIO}.part`), {
        isAllowedHost: deps.isAllowedHost,
        idleTimeoutMs: deps.downloadIdleTimeoutMs ?? 60_000,
      });
      return { ok: true, bytes: r.bytes, sha256: r.sha256, detail };
    } catch (e) {
      if (e instanceof DownloadError && e.status === 403 && !refreshed) {
        if (await refresh()) continue; // expired presigned URL: not an attempt
      }
      return { ok: false, errorClass: e instanceof DownloadError ? e.errorClass : "download_error" };
    }
  }
}

function writeReport(root: string, report: PullReport): string | null {
  try {
    const dir = reportsDir(root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, `${report.run.id}.json`);
    writeFileSync(p, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return p;
  } catch {
    return null;
  }
}
