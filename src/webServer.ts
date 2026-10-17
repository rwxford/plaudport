import { archiveShare } from "./archive.js";
import { config, refreshCachedCredentials } from "./config.js";
import { humanDuration } from "./format.js";
import { importArchive } from "./importer.js";
import { parseLinkList } from "./linkList.js";
import { readTokenExpiry } from "./jwt.js";
import { reloadCredentialsFromEnvFile, unwrapValue } from "./env.js";
import { parseShareUrl, ShareUrlError } from "./shareUrl.js";
import { assertTokenUsable, requestUpload, UploadError } from "./uploadClient.js";
import { ShareApiError } from "./shareClient.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, relative, resolve, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { pageHtml } from "./webPage.js";
export { pageHtml } from "./webPage.js";

/**
 * A local web page for the share-import pipeline (PRD-SHARE-IMPORT S4): paste a
 * link, click Import, watch it run. It's the same `archiveShare` → `importArchive`
 * path the CLI uses, with progress streamed to the browser over SSE.
 *
 * It binds to loopback and is meant to stay there: this page can trigger uploads
 * to your Plaud, so it must never be reachable off your machine. Two guards, both
 * tested below:
 *   - every /api/* request's Host header must be loopback (blocks DNS-rebinding
 *     from a page on another site pointed at 127.0.0.1 under a hostname);
 *   - every /api/* request must carry a per-run token the served page embeds and
 *     a foreign site cannot read (blocks ordinary cross-site requests).
 * The bearer token itself is never sent to the browser — only its expiry.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in webServer.test.ts)
// ---------------------------------------------------------------------------

/** Loopback Host header check. Accepts 127.0.0.0/8, ::1, and localhost, with or
 *  without a port; anything else (a real hostname pointed at us) is refused. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  // Strip the port. IPv6 literals are bracketed: [::1]:4317.
  if (host.startsWith("[")) {
    host = host.slice(1, host.indexOf("]"));
  } else if (host.includes(":")) {
    host = host.slice(0, host.indexOf(":"));
  }
  if (host === "localhost" || host === "::1") return true;
  // 127.0.0.0/8
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets[0] === 127 && octets.every((o) => o >= 0 && o <= 255);
}

/** Constant-time token compare that never throws on length or encoding. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthStatus {
  set: boolean;
  expired: boolean;
  /** "in 5h 2m" / "3h ago"; absent when no token is set. */
  relative?: string;
  expiresAt?: string;
}

/** The credential's state for the page — expiry only, never the token. */
export function authStatus(now = Date.now()): AuthStatus {
  const auth = unwrapValue(process.env.PLAUD_AUTH ?? "");
  if (!auth) return { set: false, expired: true };
  const expiry = readTokenExpiry(auth, now);
  if (!expiry) return { set: true, expired: true };
  return { set: true, expired: expiry.expired, relative: expiry.relative, expiresAt: expiry.expiresAt.toISOString() };
}

export interface ImportRequest {
  links: string[];
  fetchOnly: boolean;
  extraCopy: boolean;
}

export class RequestError extends Error {}

/** Validate and normalise a POST /api/import body. */
export function parseImportRequest(body: unknown): ImportRequest {
  if (typeof body !== "object" || body === null) throw new RequestError("Expected a JSON object.");
  const b = body as Record<string, unknown>;
  const raw = typeof b.links === "string" ? b.links : "";
  const links = parseLinkList(raw);
  if (links.length === 0) throw new RequestError("Paste at least one share link.");
  return { links, fetchOnly: b.fetchOnly === true, extraCopy: b.extraCopy === true };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

type JobStatus = "running" | "done" | "error";

export interface RecordingProgress {
  index: number;
  stage: "waiting" | "downloading" | "saved" | "uploading" | "imported" | "already-imported" | "archived" | "failed";
  title?: string;
  recordedAt?: string | null;
  duration?: string;
  detail?: string;
  hasBackup?: boolean;
}

/** Existing archive only; never accept an arbitrary filesystem path from the page. */
export function safeBackupPath(dir: string, root = config.dataDir): string {
  const base = realpathSync(resolve(root, "shares"));
  const target = realpathSync(dir);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new RequestError("Backup is not in the archive folder.");
  return target;
}

function openFolder(path: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.reject(new Error("Opening folders is available on macOS."));
  return new Promise((done, reject) => execFile("/usr/bin/open", [path], (error) => error ? reject(error) : done()));
}


interface Job {
  id: string;
  status: JobStatus;
  lines: string[];
  listeners: Set<ServerResponse>;
  startedAt: number;
  recordings: Map<number, RecordingProgress>;
  backups: Map<number, string>;
  /** Kept so a browser connecting after the job ends still gets the counts. */
  summary?: unknown;
}

interface Outcome {
  index: number;
  recordedAt?: string | null;
  duration?: string;
  hasBackup?: boolean;
  url: string;
  shareId?: string;
  title?: string;
  status: "imported" | "already-imported" | "archived" | "failed";
  fileId?: string;
  detail?: string;
}

export class Jobs {
  private readonly map = new Map<string, Job>();

  create(): Job {
    const job: Job = { id: randomBytes(9).toString("hex"), status: "running", lines: [], listeners: new Set(), startedAt: Date.now(), recordings: new Map(), backups: new Map() };
    this.map.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.map.get(id);
  }

  append(job: Job, line: string): void {
    job.lines.push(line);
    for (const res of job.listeners) sendSse(res, "log", { line });
  }

  update(job: Job, update: RecordingProgress): void {
    const previous = job.recordings.get(update.index);
    const next = { ...previous, ...update };
    job.recordings.set(update.index, next);
    for (const res of job.listeners) sendSse(res, "recording", next);
  }

  finish(job: Job, status: Exclude<JobStatus, "running">, summary: unknown): void {
    job.status = status;
    job.summary = summary;
    for (const res of job.listeners) {
      sendSse(res, "done", { status, summary });
      res.end();
    }
    job.listeners.clear();
  }
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Serialize work that shares a key, so two jobs can't race the same share:
 * archiving writes the same files and the duplicate check reads a manifest the
 * other job is about to write. Distinct shares still run concurrently.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn); // run after prev whether it resolved or threw
    const tail = result.catch(() => {}); // a non-rejecting link to chain the next on
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * Run one import job: archive each link, then (unless fetch-only) upload it.
 * Mirrors the CLI's per-link path so the two behave the same.
 *
 * `locks` serializes per-share work across all jobs; pass the server's shared
 * instance so concurrent submissions of the same link can't race.
 */
export async function runImport(jobs: Jobs, job: Job, req: ImportRequest, locks = new KeyedMutex(), envPath = ".env"): Promise<void> {
  const log = (l: string) => jobs.append(job, l);
  const outcomes: Outcome[] = [];
  req.links.forEach((_, index) => jobs.update(job, { index, stage: "waiting" }));

  if (!req.fetchOnly) {
    // Pick up a token refreshed by `npm run set:auth` since this server started,
    // and drop cached session headers so they can't lag behind the new bearer.
    reloadCredentialsFromEnvFile(envPath);
    refreshCachedCredentials();
    try {
      if (!authStatus().set || authStatus().expired || unwrapValue(process.env.PLAUD_USER_TOKEN ?? "").length < 10) {
        throw new UploadError("Open Plaud in Chrome, sign in to your Personal workspace, then refresh the connection.");
      }
      assertTokenUsable();
    } catch (e) {
      if (e instanceof UploadError) {
        log(`Credential problem: ${e.message}`);
        if (e.hint) log(e.hint);
        log("Open Plaud in Chrome, reload your Personal workspace, then refresh the connection and try again.");
        req.links.forEach((_, index) => jobs.update(job, { index, stage: "failed", detail: "Refresh your Plaud connection, then retry." }));
        jobs.finish(job, "error", { reason: "auth" });
        return;
      }
      throw e;
    }
  }

  for (const [i, url] of req.links.entries()) {
    const pos = req.links.length > 1 ? `[${i + 1}/${req.links.length}] ` : "";
    jobs.update(job, { index: i, stage: "downloading" });
    let ref;
    try {
      ref = parseShareUrl(url);
    } catch (e) {
      const detail = e instanceof ShareUrlError ? e.message.split("\n")[0]! : String(e);
      log(`${pos}SKIP — ${detail}`);
      outcomes.push({ index: i, url, status: "failed", detail });
      jobs.update(job, { index: i, stage: "failed", detail });
      continue;
    }

    log(`${pos}${ref.shareId}`);
    try {
      // Hold the share's lock across archive AND import, so a second job for the
      // same link can't interleave file writes or slip past the duplicate check.
      const outcome = await locks.run(ref.shareId, async (): Promise<Outcome> => {
        const { dir, manifest, audioError } = await archiveShare(ref, { log: (l) => log(`   ${l.trim()}`) });
        job.backups.set(i, dir);
        const metadata = { index: i, title: manifest.title, recordedAt: manifest.recordedAt, duration: humanDuration(manifest.durationMs ?? undefined), hasBackup: true };
        jobs.update(job, { ...metadata, stage: "saved" });
        log(`   ${manifest.title}`);
        log(`   ${humanDuration(manifest.durationMs ?? undefined)}, ${manifest.counts.utterances} utterances`);

        if (audioError || !manifest.audio) {
          log(`   NO AUDIO: ${audioError ?? "this share has none"}`);
          return { ...metadata, url, shareId: ref.shareId, status: "archived", detail: audioError ?? "This share has no audio. Only the available text was saved." };
        }
        if (req.fetchOnly) {
          log("   Archived.");
          return { ...metadata, url, shareId: ref.shareId, status: "archived" };
        }

        jobs.update(job, { index: i, stage: "uploading" });
        const result = await importArchive({
          audioPath: join(dir, manifest.audio.file),
          title: manifest.title,
          startTime: manifest.recordedAt ? Date.parse(manifest.recordedAt) : Date.now(),
          shareDir: dir,
          extraCopy: req.extraCopy,
          log: (l) => log(`   ${l.trim()}`),
        });
        log(
          result.status === "already-imported"
            ? `   Already in Plaud as ${result.fileIdPrefixed} — skipped`
            : result.wasAlreadyImported
              ? `   Imported again as ${result.fileIdPrefixed} (was already in Plaud as ${result.previousFileIdPrefixed})`
              : `   Imported as ${result.fileIdPrefixed}`,
        );
        if (result.status !== "already-imported" && result.checksumMatched === false) log("   WARNING: checksum differs from Plaud's copy.");
        return { ...metadata, url, shareId: ref.shareId, status: result.status, fileId: result.fileIdPrefixed, detail: result.checksumMatched === false ? "Uploaded, but the checksum differs. Check the recording in Plaud before relying on it." : undefined };
      });
      outcomes.push(outcome);
      jobs.update(job, { ...outcome, stage: outcome.status });
    } catch (e) {
      const detail = e instanceof ShareApiError ? (e.hint ?? "Could not read this share. Check your internet connection or ask its owner for a new share link.") : e instanceof UploadError ? e.message.split("\n")[0]! : "Could not complete this recording. Check Technical details and retry.";
      log(`   FAILED: ${detail}`);
      outcomes.push({ index: i, url, shareId: ref.shareId, status: "failed", detail, hasBackup: job.backups.has(i) });
      jobs.update(job, { index: i, stage: "failed", detail, hasBackup: job.backups.has(i) });
      if (e instanceof UploadError && /expired/i.test(e.message)) {
        log("Stopping: your session expired. Reload Plaud in Chrome, refresh the connection, then retry.");
        for (let pending = i + 1; pending < req.links.length; pending++) {
          const detail = "Not started because your session expired. Refresh the connection and retry.";
          outcomes.push({ index: pending, url: req.links[pending]!, status: "failed", detail });
          jobs.update(job, { index: pending, stage: "failed", detail });
        }
        break;
      }
    }
  }

  const failed = outcomes.filter((o) => o.status === "failed").length;
  jobs.finish(job, failed && failed === outcomes.length ? "error" : "done", {
    imported: outcomes.filter((o) => o.status === "imported").length,
    already: outcomes.filter((o) => o.status === "already-imported").length,
    archived: outcomes.filter((o) => o.status === "archived").length,
    failed,
    outcomes,
  });
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new RequestError("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

export function createServer(sessionToken: string, jobs = new Jobs(), opts: { envPath?: string; locks?: KeyedMutex; openBackup?: (path: string) => Promise<void>; checkConnection?: () => Promise<unknown> } = {}): Server {
  const envPath = opts.envPath ?? ".env";
  const locks = opts.locks ?? new KeyedMutex();
  return createHttpServer(async (req, res) => {
    try {
      // Parse inside the try: a malformed request target (e.g. "//[") throws in
      // the URL constructor, and before this was in the handler's scope it took
      // the whole server down with an uncaught exception.
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        sendJson(res, 400, { error: "Bad request target." });
        return;
      }
      const path = url.pathname;

      // Loopback gate first, before anything is served — the page carries the
      // session token, so a non-loopback Host (DNS-rebinding) must not get it.
      if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: "This server only answers loopback requests." });
        return;
      }

      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(pageHtml(sessionToken));
        return;
      }

      // Everything below is API: token gated (Host already checked above).
      if (path.startsWith("/api/")) {
        // Header for fetch(); query ?t= for EventSource, which cannot set headers.
        const provided = (req.headers["x-plaudport-token"] as string | undefined) ?? url.searchParams.get("t") ?? undefined;
        if (!tokenMatches(sessionToken, provided)) {
          sendJson(res, 403, { error: "Missing or wrong session token. Reload the page served by this process." });
          return;
        }

        if (req.method === "GET" && path === "/api/auth") {
          // Reflect a token refreshed since startup (npm run set:auth).
          reloadCredentialsFromEnvFile(envPath);
          refreshCachedCredentials();
          sendJson(res, 200, { ...authStatus(), userTokenSet: unwrapValue(process.env.PLAUD_USER_TOKEN ?? "").length >= 10 });
          return;
        }

        if (req.method === "POST" && path === "/api/auth/check") {
          reloadCredentialsFromEnvFile(envPath);
          refreshCachedCredentials();
          const state = authStatus();
          if (!state.set || state.expired || unwrapValue(process.env.PLAUD_USER_TOKEN ?? "").length < 10) {
            sendJson(res, 409, { verified: false, error: "Open Plaud in Chrome, sign in to Personal, reload Plaud, then check again." });
            return;
          }
          try {
            // A discarded upload target creates no recording, just as check:auth does.
            await (opts.checkConnection ?? (() => requestUpload(1_048_576)))();
            sendJson(res, 200, { verified: true, ...state });
          } catch {
            sendJson(res, 502, { verified: false, error: "Plaud could not verify this connection. Reload your signed-in Personal workspace and try again. If it still fails, check your internet connection." });
          }
          return;
        }

        const backupMatch = /^\/api\/jobs\/([0-9a-f]+)\/recordings\/(\d+)\/backup$/.exec(path);
        if (req.method === "POST" && backupMatch) {
          const job = jobs.get(backupMatch[1]!);
          const dir = job?.backups.get(Number(backupMatch[2]));
          if (!dir) { sendJson(res, 404, { error: "No backup is available for this recording." }); return; }
          try {
            await (opts.openBackup ?? openFolder)(safeBackupPath(dir));
            sendJson(res, 200, { opened: true });
          } catch {
            sendJson(res, 400, { error: "Could not open the backup folder. It may have moved, or folder opening is not supported on this system." });
          }
          return;
        }

        if (req.method === "POST" && path === "/api/import") {
          let parsed: ImportRequest;
          try {
            parsed = parseImportRequest(JSON.parse((await readBody(req)) || "{}"));
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Bad request." });
            return;
          }
          const job = jobs.create();
          void runImport(jobs, job, parsed, locks, envPath).catch((e) => jobs.finish(job, "error", { reason: String(e) }));
          sendJson(res, 202, { jobId: job.id });
          return;
        }

        const eventsMatch = /^\/api\/jobs\/([0-9a-f]+)\/events$/.exec(path);
        if (req.method === "GET" && eventsMatch) {
          const job = jobs.get(eventsMatch[1]!);
          if (!job) {
            sendJson(res, 404, { error: "No such job." });
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          for (const line of job.lines) sendSse(res, "log", { line });
          for (const recording of job.recordings.values()) sendSse(res, "recording", recording);
          if (job.status !== "running") {
            // Replay the stored summary so a late subscriber still gets the counts.
            sendSse(res, "done", { status: job.status, summary: job.summary });
            res.end();
            return;
          }
          job.listeners.add(res);
          req.on("close", () => job.listeners.delete(res));
          return;
        }

        sendJson(res, 404, { error: "Unknown endpoint." });
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : "Server error." });
    }
  });
}

async function main(): Promise<void> {
  const sessionToken = randomBytes(18).toString("hex");
  const jobs = new Jobs();
  const server = createServer(sessionToken, jobs);
  const host = config.webHost;
  const port = config.webPort;

  server.listen(port, host, () => {
    const shown = host.includes(":") ? `[${host}]` : host;
    console.log(`\nPlaudPort web UI on http://${shown}:${port}`);
    if (!isLoopbackHost(`${host}:${port}`)) {
      console.log("WARNING: PLAUDPORT_HOST is not loopback. This UI can upload to your Plaud; keep it on 127.0.0.1.");
    }
    const auth = authStatus();
    console.log(auth.set && !auth.expired ? "  Saved session found. Use Check connection in the page to verify it with Plaud." : "  Open Plaud in Chrome and sign in to connect. You can save local copies without signing in.");
    console.log("  Keep this Terminal window open. Press Control-C to stop PlaudPort.\n");
    if (process.argv.includes("--open") && process.platform === "darwin" && isLoopbackHost(`${host}:${port}`)) {
      execFile("/usr/bin/open", [`http://${shown}:${port}`], (error) => {
        if (error) console.log("  Your browser could not be opened automatically. Open the URL above.");
      });
    }
  });
  server.on("error", (e) => {
    console.error(`Could not start the web server: ${(e as Error).message}`);
    process.exit(1);
  });
}

// Run only when invoked directly, so tests can import the helpers.
if (process.argv[1] && /webServer\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
