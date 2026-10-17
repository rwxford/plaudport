import { archiveShare } from "./archive.js";
import { config, refreshCachedCredentials } from "./config.js";
import { humanDuration } from "./format.js";
import { importArchive } from "./importer.js";
import { parseLinkList } from "./linkList.js";
import { readTokenExpiry } from "./jwt.js";
import { reloadCredentialsFromEnvFile, unwrapValue } from "./env.js";
import { parseShareUrl, ShareUrlError } from "./shareUrl.js";
import { assertTokenUsable, UploadError } from "./uploadClient.js";
import { ShareApiError } from "./shareClient.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

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

interface Job {
  id: string;
  status: JobStatus;
  lines: string[];
  listeners: Set<ServerResponse>;
  startedAt: number;
  /** Kept so a browser connecting after the job ends still gets the counts. */
  summary?: unknown;
}

interface Outcome {
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
    const job: Job = { id: randomBytes(9).toString("hex"), status: "running", lines: [], listeners: new Set(), startedAt: Date.now() };
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

  if (!req.fetchOnly) {
    // Pick up a token refreshed by `npm run set:auth` since this server started,
    // and drop cached session headers so they can't lag behind the new bearer.
    reloadCredentialsFromEnvFile(envPath);
    refreshCachedCredentials();
    try {
      assertTokenUsable();
    } catch (e) {
      if (e instanceof UploadError) {
        log(`Credential problem: ${e.message}`);
        if (e.hint) log(e.hint);
        log("Refresh it with `npm run set:auth`, then try again.");
        jobs.finish(job, "error", { reason: "auth" });
        return;
      }
      throw e;
    }
  }

  for (const [i, url] of req.links.entries()) {
    const pos = req.links.length > 1 ? `[${i + 1}/${req.links.length}] ` : "";
    let ref;
    try {
      ref = parseShareUrl(url);
    } catch (e) {
      const detail = e instanceof ShareUrlError ? e.message.split("\n")[0]! : String(e);
      log(`${pos}SKIP — ${detail}`);
      outcomes.push({ url, status: "failed", detail });
      continue;
    }

    log(`${pos}${ref.shareId}`);
    try {
      // Hold the share's lock across archive AND import, so a second job for the
      // same link can't interleave file writes or slip past the duplicate check.
      const outcome = await locks.run(ref.shareId, async (): Promise<Outcome> => {
        const { dir, manifest, audioError } = await archiveShare(ref, { log: (l) => log(`   ${l.trim()}`) });
        log(`   ${manifest.title}`);
        log(`   ${humanDuration(manifest.durationMs ?? undefined)}, ${manifest.counts.utterances} utterances`);

        if (audioError || !manifest.audio) {
          log(`   NO AUDIO: ${audioError ?? "this share has none"}`);
          return { url, shareId: ref.shareId, title: manifest.title, status: "archived", detail: audioError };
        }
        if (req.fetchOnly) {
          log("   Archived.");
          return { url, shareId: ref.shareId, title: manifest.title, status: "archived" };
        }

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
        return { url, shareId: ref.shareId, title: manifest.title, status: result.status, fileId: result.fileIdPrefixed };
      });
      outcomes.push(outcome);
    } catch (e) {
      const detail = e instanceof ShareApiError || e instanceof UploadError ? e.message.split("\n")[0]! : String(e);
      log(`   FAILED: ${detail}`);
      outcomes.push({ url, shareId: ref.shareId, status: "failed", detail });
      if (e instanceof UploadError && /expired/i.test(e.message)) {
        log("Stopping: the credential expired mid-run. Refresh with `npm run set:auth` and re-run.");
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

export function createServer(sessionToken: string, jobs = new Jobs(), opts: { envPath?: string; locks?: KeyedMutex } = {}): Server {
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
          sendJson(res, 200, authStatus());
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

/** The single page. Token is embedded so the page's own fetches authenticate;
 *  a foreign site in the same browser cannot read it. */
export function pageHtml(sessionToken: string): string {
  const token = sessionToken.replace(/[^a-f0-9]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PlaudPort</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --card: #fff; --line: #e2e2e2; --accent: #2b6cb0; --muted: #666; --ok: #2f855a; --warn: #c05621; --err: #c53030; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --bg: #1a1a1a; --card: #242424; --line: #3a3a3a; --accent: #63b3ed; --muted: #9a9a9a; --ok: #68d391; --warn: #f6ad55; --err: #fc8181; } }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 24px; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  label { font-weight: 600; display: block; margin-bottom: 6px; }
  textarea { width: 100%; min-height: 90px; font: 13px/1.4 ui-monospace, Menlo, monospace; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); resize: vertical; }
  .opts { display: flex; gap: 18px; margin: 12px 0; flex-wrap: wrap; }
  .opts label { font-weight: 400; display: flex; align-items: center; gap: 6px; margin: 0; }
  button { font: inherit; font-weight: 600; background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 20px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #auth { font-size: 13px; padding: 8px 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid var(--line); }
  #auth.ok { color: var(--ok); } #auth.warn { color: var(--warn); } #auth.err { color: var(--err); }
  #log { font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-height: 60px; max-height: 420px; overflow: auto; margin-top: 12px; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>PlaudPort</h1>
  <p class="sub">Paste a Plaud share link, import it into your Personal workspace.</p>
  <div id="auth">Checking credentials…</div>
  <div class="card">
    <label for="links">Share links (one per line)</label>
    <textarea id="links" placeholder="https://web.plaud.ai/s/pub_xxxxxxxx::xxxxxxxx"></textarea>
    <div class="opts">
      <label><input type="checkbox" id="fetchOnly"> Archive only (don't upload)</label>
      <label><input type="checkbox" id="extraCopy"> Import again if already there</label>
    </div>
    <button id="go">Import</button>
    <p class="hint">Runs on your machine. Nothing leaves it except between you and Plaud.</p>
  </div>
  <div class="card">
    <label>Progress</label>
    <div id="log">Idle.</div>
  </div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const H = { "x-plaudport-token": TOKEN };
  const log = document.getElementById("log");
  const go = document.getElementById("go");
  const authEl = document.getElementById("auth");

  async function refreshAuth() {
    try {
      const r = await fetch("/api/auth", { headers: H });
      const a = await r.json();
      if (!a.set) { authEl.className = "err"; authEl.textContent = "No PLAUD_AUTH set. Add it with 'npm run set:auth'. You can still Archive only."; }
      else if (a.expired) { authEl.className = "err"; authEl.textContent = "Token expired. Refresh with 'npm run set:auth' before importing."; }
      else { authEl.className = "ok"; authEl.textContent = "Credentials OK — token expires " + a.relative + "."; }
    } catch { authEl.className = "warn"; authEl.textContent = "Couldn't check credentials."; }
  }

  function line(t) { log.textContent += (log.textContent === "Idle." ? "" : "\\n") + t; log.scrollTop = log.scrollHeight; }

  go.onclick = async () => {
    const links = document.getElementById("links").value;
    const fetchOnly = document.getElementById("fetchOnly").checked;
    const extraCopy = document.getElementById("extraCopy").checked;
    go.disabled = true; log.textContent = "Idle.";
    try {
      const r = await fetch("/api/import", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ links, fetchOnly, extraCopy }) });
      const j = await r.json();
      if (!r.ok) { line("Error: " + (j.error || r.status)); go.disabled = false; return; }
      const es = new EventSource("/api/jobs/" + j.jobId + "/events?t=" + encodeURIComponent(TOKEN));
      es.addEventListener("log", (e) => line(JSON.parse(e.data).line));
      es.addEventListener("done", (e) => {
        const d = JSON.parse(e.data);
        if (d.summary) line("\\nDone — imported " + d.summary.imported + ", already there " + d.summary.already + ", archived " + d.summary.archived + ", failed " + d.summary.failed + ".");
        es.close(); go.disabled = false; refreshAuth();
      });
      es.onerror = () => { line("(connection closed)"); es.close(); go.disabled = false; };
    } catch (e) { line("Error: " + e); go.disabled = false; }
  };

  refreshAuth();
</script>
</body>
</html>`;
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
    console.log(auth.set ? (auth.expired ? "  Token is expired — run `npm run set:auth` before importing." : `  Token OK, expires ${auth.relative}.`) : "  No token set — Archive only until you run `npm run set:auth`.");
    console.log("  Open that URL in your browser. Ctrl-C to stop.\n");
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
