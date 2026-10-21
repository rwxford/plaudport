import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";

/** A JWT with the given expiry (seconds from now). Only the payload matters here. */
function jwt(expInSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSeconds })}.sig`;
}

// A tiny 2-second WAV, enough for the archiver to download and checksum.
function makeWav(): Buffer {
  const rate = 8000, seconds = 1, n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// --- Stand-in Plaud share API, started before webServer is imported so that
//     config picks up its address. ---
const AUDIO = makeWav();
let standIn: Server;
let dataDir: string;
let noEnv: string; // a path with no file, so the credential reload is a no-op in tests
let mod: typeof import("./webServer.js");
let fixtureTitle = "Web UI test meeting";
let failAudio = false;

before(async () => {
  standIn = createHttpServer((req, res) => {
    const url = req.url ?? "";
    if (url.includes("/share/access/") && url.endsWith("/audio")) {
      if (failAudio) { res.writeHead(503); res.end(); return; }
      const port = (standIn.address() as AddressInfo).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 0, temp_url: `http://127.0.0.1:${port}/media.wav` }));
    } else if (url.startsWith("/media.wav")) {
      res.writeHead(200, { "content-type": "audio/wav", "content-length": AUDIO.length });
      res.end(AUDIO);
    } else if (url.includes("/share/access/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status: 0, object_type: "file", is_audio: 1, is_trans: 1,
        data_file: {
          id: "0".repeat(32), filename: fixtureTitle, start_time: 1789402715000, duration: 1000, file_language: "en",
          trans_result: [{ start_time: 0, end_time: 1000, speaker: "A", content: "hello" }],
        },
      }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => standIn.listen(0, "127.0.0.1", r));
  const port = (standIn.address() as AddressInfo).port;

  dataDir = mkdtempSync(join(tmpdir(), "plaudport-web-"));
  noEnv = join(dataDir, "nonexistent.env");
  process.env.PLAUD_ALLOWED_HOSTS = "web.plaud.ai,127.0.0.1";
  process.env.PLAUD_SHARE_API_BASE = `http://127.0.0.1:${port}`;
  process.env.PLAUD_DATA_DIR = dataDir;
  process.env.PLAUD_USER_TOKEN = "demo-user-token";
  process.env.PLAUD_AUTH = `Bearer ${jwt(3600)}`;

  mod = await import("./webServer.js");
});

after(() => {
  standIn?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("isLoopbackHost accepts loopback, rejects anything else", async () => {
  const { isLoopbackHost } = mod;
  for (const h of ["127.0.0.1", "127.0.0.1:4317", "localhost:4317", "[::1]:4317", "127.5.5.5"]) assert.ok(isLoopbackHost(h), h);
  for (const h of [undefined, "", "plaud.ai", "evil.com:4317", "10.0.0.1", "0.0.0.0", "169.254.1.1.nip.io"]) assert.ok(!isLoopbackHost(h), String(h));
});

test("tokenMatches is exact and length-safe", () => {
  const { tokenMatches } = mod;
  assert.ok(tokenMatches("abc123", "abc123"));
  assert.ok(!tokenMatches("abc123", "abc124"));
  assert.ok(!tokenMatches("abc123", "abc1234"));
  assert.ok(!tokenMatches("abc123", ""));
  assert.ok(!tokenMatches("abc123", undefined));
});

test("parseImportRequest reads links and flags, rejects empty", () => {
  const { parseImportRequest, RequestError } = mod;
  const r = parseImportRequest({ links: "https://web.plaud.ai/s/pub_x::y\n# a note\n\nhttps://web.plaud.ai/s/pub_z::w", fetchOnly: true });
  assert.deepEqual(r.links, ["https://web.plaud.ai/s/pub_x::y", "https://web.plaud.ai/s/pub_z::w"]);
  assert.equal(r.fetchOnly, true);
  assert.equal(r.extraCopy, false);
  assert.throws(() => parseImportRequest({ links: "# only a comment" }), RequestError);
  assert.throws(() => parseImportRequest("nope"), RequestError);
});

test("authStatus reports expiry, never the token", () => {
  const { authStatus } = mod;
  const saved = process.env.PLAUD_AUTH;
  try {
    process.env.PLAUD_AUTH = "";
    assert.deepEqual(authStatus(), { set: false, expired: true });
    process.env.PLAUD_AUTH = `Bearer ${jwt(-60)}`;
    assert.equal(authStatus().expired, true);
    process.env.PLAUD_AUTH = `Bearer ${jwt(7200)}`;
    const ok = authStatus();
    assert.equal(ok.set, true);
    assert.equal(ok.expired, false);
    assert.ok(!JSON.stringify(ok).includes("eyJ"), "status must not leak the JWT");
  } finally {
    process.env.PLAUD_AUTH = saved;
  }
});

// --- HTTP integration: the gates, then a real fetch-only import over SSE. ---

function listen(server: Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
}

test("API refuses a wrong session token", async () => {
  const server = mod.createServer("abc123def456", undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/auth`, { headers: { "x-plaudport-token": "wrong" } });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    r.on("error", reject);
    r.end();
  });
}

test("API refuses a non-loopback Host header", async () => {
  const token = "abc123def456";
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    const status = await rawGet(port, "/api/auth", { "x-plaudport-token": token, host: "evil.example.com" });
    assert.equal(status, 403);
    // same request with a loopback Host is allowed through the gate
    const ok = await rawGet(port, "/api/auth", { "x-plaudport-token": token, host: "127.0.0.1:" + port });
    assert.equal(ok, 200);
  } finally {
    server.close();
  }
});

test("a malformed request target returns 400 and keeps the server up", async () => {
  const token = "abc123def456";
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    // "//[" makes `new URL` throw; before the fix that crashed the whole server.
    const bad = await new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "//[", method: "GET" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(bad, 400);
    // The server is still answering afterwards.
    const alive = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(alive.status, 200);
  } finally {
    server.close();
  }
});

test("refreshCachedCredentials re-reads the user token and adopts a configured device id", async () => {
  const { requireUserToken, getDeviceId, refreshCachedCredentials } = await import("./config.js");
  const savedTok = process.env.PLAUD_USER_TOKEN;
  const savedDev = process.env.PLAUD_DEVICE_ID;
  try {
    process.env.PLAUD_USER_TOKEN = "user-token-aaaa";
    refreshCachedCredentials();
    assert.equal(requireUserToken(), "user-token-aaaa");
    // A later env change is NOT seen until the cache is refreshed…
    process.env.PLAUD_USER_TOKEN = "user-token-bbbb";
    assert.equal(requireUserToken(), "user-token-aaaa", "stays cached until refreshed");
    refreshCachedCredentials();
    assert.equal(requireUserToken(), "user-token-bbbb", "re-read after refresh");
    // …and a newly-configured device id is adopted.
    process.env.PLAUD_DEVICE_ID = "device-configured-1234";
    refreshCachedCredentials();
    assert.equal(getDeviceId(), "device-configured-1234");
  } finally {
    process.env.PLAUD_USER_TOKEN = savedTok;
    process.env.PLAUD_DEVICE_ID = savedDev;
    refreshCachedCredentials();
  }
});

test("the page embeds the token and never the bearer", async () => {
  const token = "abc123def456";
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes(token), "page carries its own session token");
    assert.ok(!html.includes("eyJ"), "page must not carry the bearer");
  } finally {
    server.close();
  }
});

test("a fetch-only import archives the share and streams progress to completion", async () => {
  const token = randomBytes(8).toString("hex");
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    const start = await fetch(`http://127.0.0.1:${port}/api/import`, {
      method: "POST",
      headers: { "x-plaudport-token": token, "content-type": "application/json" },
      body: JSON.stringify({ links: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::demotoken", fetchOnly: true }),
    });
    assert.equal(start.status, 202);
    const { jobId } = (await start.json()) as { jobId: string };
    assert.match(jobId, /^[0-9a-f]+$/);

    // Read the SSE stream to its terminal "done" event.
    const events = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?t=${token}`, { headers: { accept: "text/event-stream" } });
    assert.equal(events.status, 200);
    const text = await events.text(); // server ends the stream after "done"
    assert.ok(/event: done/.test(text), `stream ended with a done event:\n${text}`);
    assert.ok(/Web UI test meeting/.test(text), "progress named the archived meeting");
    assert.ok(/"archived":1/.test(text), `summary counted one archive:\n${text}`);
    assert.ok(!/eyJ/.test(text), "stream must not leak the bearer");

    // The archive really landed on disk.
    const { readManifest } = await import("./archive.js");
    const slug = "pub_00000000-0000-4000-8000-000000000000-web-ui-test-meeting";
    const manifest = readManifest(join(dataDir, "shares", slug));
    assert.ok(manifest?.audio, "audio archived");
  } finally {
    server.close();
  }
});

test("a subscriber connecting after the job finishes still gets the summary", async () => {
  const token = randomBytes(8).toString("hex");
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    const start = await fetch(`http://127.0.0.1:${port}/api/import`, {
      method: "POST",
      headers: { "x-plaudport-token": token, "content-type": "application/json" },
      body: JSON.stringify({ links: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::demotoken", fetchOnly: true }),
    });
    const { jobId } = (await start.json()) as { jobId: string };

    // Let the fetch-only job finish before connecting, so this is the late path.
    await new Promise((r) => setTimeout(r, 300));
    const events = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?t=${token}`);
    const text = await events.text();
    assert.ok(/event: done/.test(text), `got a done event:\n${text}`);
    assert.ok(/"archived":1/.test(text), `late subscriber still gets the summary counts:\n${text}`);
  } finally {
    server.close();
  }
});

test("the page is NOT served to a non-loopback Host (token can't leak via rebinding)", async () => {
  const token = "abc123def456";
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    const foreign = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", headers: { host: "evil.example.com" } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(foreign.status, 403);
    assert.ok(!foreign.body.includes(token), "the session token must not be served to a foreign Host");
  } finally {
    server.close();
  }
});

test("reloadCredentialsFromEnvFile picks up a token rewritten since startup", async () => {
  const { reloadCredentialsFromEnvFile } = await import("./env.js");
  const envFile = join(dataDir, "reload.env");
  const saved = process.env.PLAUD_AUTH;
  try {
    process.env.PLAUD_AUTH = `Bearer ${jwt(-60)}`; // stale, as if loaded at startup
    const fresh = `Bearer ${jwt(3600)}`;
    writeFileSync(envFile, `PLAUD_AUTH=${fresh}\nUNRELATED=keepme\n`);
    reloadCredentialsFromEnvFile(envFile);
    assert.equal(process.env.PLAUD_AUTH, fresh, "credential reloaded from the file, overwriting the stale one");
    // A missing file is a no-op, not a throw or a wipe.
    reloadCredentialsFromEnvFile(join(dataDir, "does-not-exist.env"));
    assert.equal(process.env.PLAUD_AUTH, fresh);
    // An empty credential line (the Chrome-sync .env shape) must NOT wipe a live
    // value — otherwise /api/auth would report "no token" and an import would stop.
    writeFileSync(envFile, `PLAUD_AUTH=\nPLAUD_USER_TOKEN=\n`);
    reloadCredentialsFromEnvFile(envFile);
    assert.equal(process.env.PLAUD_AUTH, fresh, "empty .env line left the live credential intact");
  } finally {
    process.env.PLAUD_AUTH = saved;
  }
});

test("KeyedMutex serializes the same key and runs different keys concurrently", async () => {
  const { KeyedMutex } = mod;
  const m = new KeyedMutex();
  const order: string[] = [];
  const gated = (tag: string, ms: number) => () =>
    new Promise<void>((r) => {
      order.push(`${tag}:start`);
      setTimeout(() => {
        order.push(`${tag}:end`);
        r();
      }, ms);
    });

  // Same key: B must not start until A ends.
  const a = m.run("k", gated("A", 30));
  const b = m.run("k", gated("B", 1));
  await Promise.all([a, b]);
  assert.deepEqual(order, ["A:start", "A:end", "B:start", "B:end"]);

  // Different keys: both start before either ends.
  order.length = 0;
  await Promise.all([m.run("x", gated("X", 20)), m.run("y", gated("Y", 20))]);
  assert.deepEqual(order.slice(0, 2).sort(), ["X:start", "Y:start"]);

  // A thrown task still releases the key for the next one.
  await assert.rejects(m.run("z", () => Promise.reject(new Error("boom"))));
  assert.equal(await m.run("z", () => Promise.resolve("ok")), "ok");
});


test("connection verification is token-gated and never exposes credentials", async () => {
  const token = "abc123def456";
  let checks = 0;
  const server = mod.createServer(token, undefined, { envPath: noEnv, checkConnection: async () => { checks++; } });
  const port = await listen(server);
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/auth/check`, { method: "POST" });
    assert.equal(denied.status, 403);
    assert.equal(checks, 0);
    const reply = await fetch(`http://127.0.0.1:${port}/api/auth/check`, { method: "POST", headers: { "x-plaudport-token": token } });
    assert.equal(reply.status, 200);
    assert.equal(checks, 1);
    const text = await reply.text();
    assert.equal(JSON.parse(text).verified, true);
    assert.ok(!text.includes(process.env.PLAUD_USER_TOKEN!));
    assert.ok(!text.includes(process.env.PLAUD_AUTH!));
  } finally { server.close(); }
});

test("a failed connection check gives recovery guidance without the upstream error", async () => {
  const token = "abc123def456";
  const server = mod.createServer(token, undefined, { envPath: noEnv, checkConnection: async () => { throw Error("private-upstream-error"); } });
  const port = await listen(server);
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/api/auth/check`, { method: "POST", headers: { "x-plaudport-token": token } });
    assert.equal(reply.status, 502);
    const text = await reply.text();
    assert.ok(text.includes("Reload your signed-in Personal workspace"));
    assert.ok(!text.includes("private-upstream-error"));
  } finally { server.close(); }
});

test("missing upload credentials fail the job without stopping the server", async () => {
  const token = "abc123def456", saved = process.env.PLAUD_USER_TOKEN;
  const server = mod.createServer(token, undefined, { envPath: noEnv });
  const port = await listen(server);
  try {
    process.env.PLAUD_USER_TOKEN = "";
    const start = await fetch(`http://127.0.0.1:${port}/api/import`, { method: "POST", headers: { "x-plaudport-token": token, "content-type": "application/json" }, body: JSON.stringify({ links: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::demotoken" }) });
    const { jobId } = await start.json() as { jobId: string };
    const events = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?t=${token}`)).text();
    assert.ok(events.includes('"reason":"auth"'));
    assert.ok(events.includes('"stage":"failed"'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    if (saved === undefined) delete process.env.PLAUD_USER_TOKEN; else process.env.PLAUD_USER_TOKEN = saved;
    server.close();
  }
});

test("safeBackupPath rejects outside folders and escaping symlinks", () => {
  const outside = mkdtempSync(join(tmpdir(), "plaudport-outside-"));
  const inside = join(dataDir, "shares", "safe-folder");
  const link = join(dataDir, "shares", "escaping-link");
  mkdirSync(inside, { recursive: true });
  symlinkSync(outside, link);
  try {
    assert.equal(mod.safeBackupPath(inside), realpathSync(inside));
    assert.throws(() => mod.safeBackupPath(outside));
    assert.throws(() => mod.safeBackupPath(link));
  } finally { rmSync(link); rmSync(outside, { recursive: true, force: true }); }
});

test("backup opening accepts only a known job's archive and is token-gated", async () => {
  const token = randomBytes(8).toString("hex");
  let opened = "";
  const server = mod.createServer(token, undefined, { envPath: noEnv, openBackup: async path => { opened = path; } });
  const port = await listen(server);
  try {
    const headers = { "x-plaudport-token": token, "content-type": "application/json" };
    const start = await fetch(`http://127.0.0.1:${port}/api/import`, { method: "POST", headers, body: JSON.stringify({ links: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::demotoken", fetchOnly: true }) });
    const { jobId } = await start.json() as { jobId: string };
    const stream = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?t=${token}`)).text();
    assert.ok(stream.includes('"hasBackup":true'));
    assert.ok(stream.includes('"recordedAt"'));
    assert.ok(stream.includes('event: recording'));
    assert.ok(!stream.includes(dataDir), "raw local paths must not go to the page");
    const endpoint = `http://127.0.0.1:${port}/api/jobs/${jobId}/recordings/0/backup`;
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 403);
    assert.equal(opened, "");
    assert.equal((await fetch(endpoint, { method: "POST", headers })).status, 200);
    assert.ok(opened.startsWith(realpathSync(join(dataDir, "shares"))));
    assert.equal((await fetch(endpoint.replace("/0/backup", "/999/backup"), { method: "POST", headers })).status, 404);
  } finally { server.close(); }
});

test("audio download errors remain retryable and renamed shares retain their import ledger", async () => {
  const { archiveShare, readManifest, manifestPath } = await import("./archive.js");
  const { parseShareUrl } = await import("./shareUrl.js");
  const ref = parseShareUrl("https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000001::demotoken");
  const jobs = new mod.Jobs();
  const failed = jobs.create();
  try {
    failAudio = true;
    await mod.runImport(jobs, failed, { links: [ref.url], fetchOnly: false, extraCopy: false }, undefined, noEnv);
    assert.equal(failed.recordings.get(0)?.stage, "failed");
    assert.equal(failed.recordings.get(0)?.hasBackup, true);
    assert.match(failed.recordings.get(0)?.detail ?? "", /Nothing was imported/);
    failAudio = false;
    const retried = jobs.create();
    await mod.runImport(jobs, retried, { links: [ref.url], fetchOnly: true, extraCopy: false }, undefined, noEnv);
    assert.equal(retried.recordings.get(0)?.stage, "archived");
    const first = await archiveShare(ref);
    writeFileSync(manifestPath(first.dir), JSON.stringify({ ...first.manifest, importedFileId: "fictional-existing" }));
    fixtureTitle = "Renamed fictional meeting";
    const renamed = await archiveShare(ref);
    assert.equal(renamed.dir, first.dir);
    assert.equal(renamed.manifest.title, fixtureTitle);
    assert.equal(readManifest(renamed.dir)?.importedFileId, "fictional-existing");
    const { importArchive } = await import("./importer.js");
    assert.equal((await importArchive({ audioPath: join(renamed.dir, "audio.mp3"), title: fixtureTitle, startTime: 1, shareDir: renamed.dir })).status, "already-imported");
  } finally {
    failAudio = false;
    fixtureTitle = "Web UI test meeting";
  }
});
