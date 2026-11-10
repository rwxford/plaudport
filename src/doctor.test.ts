import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePipelineSettings, type PipelineConfig } from "./config.js";
import { onBootVolume, renderDoctor, runDoctor, type DoctorEnv } from "./doctor.js";

// P0-PLAN T10 (FR21 partial; P0-D1/D2, W1, W2, R7).

const NOW = new Date("2026-11-05T12:00:00Z");
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "none" })}.${b64({ exp })}.sig`;

function env(over: Partial<DoctorEnv> = {}, cfgOver: Partial<PipelineConfig> = {}): DoctorEnv {
  const p = parsePipelineSettings({ PLAUDPORT_ARCHIVE_ROOT: "/Volumes/Archive/plaud", PLAUDPORT_MCP_DIR: "/opt/pp/mcp" });
  assert.ok(p.ok);
  const cfg = { ...(p.ok ? p.config : ({} as PipelineConfig)), ...cfgOver };
  return {
    nodeVersion: "22.1.0",
    platform: "darwin",
    cfg,
    home: "/Users/owner",
    now: NOW,
    nativeSqliteOk: () => true,
    installedMcpVersion: () => cfg.mcpVersion,
    mcpEntry: () => "/opt/pp/mcp/node_modules/@plaud-ai/mcp/dist/index.js",
    readFile: (path) =>
      path === "/Users/owner/.plaud/tokens-mcp.json"
        ? JSON.stringify({ access_token: "x", refresh_token: jwt(NOW.getTime() / 1000 + 30 * 86400), expires_at: NOW.getTime() + 3600_000 })
        : null,
    freeBytes: () => 200e9,
    probeLock: () => ({ held: false, info: null, leftoverFile: false }),
    ...over,
  };
}
const find = (r: ReturnType<typeof runDoctor>, name: string) => r.checks.find((c) => c.name === name)!;

test("all green", () => {
  const r = runDoctor(env());
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.status === "ok"), renderDoctor(r));
});

test("old Node and a broken native build fail", () => {
  const r = runDoctor(env({ nodeVersion: "18.19.0", nativeSqliteOk: () => false }));
  assert.equal(find(r, "Node").status, "fail");
  assert.equal(find(r, "SQLite (better-sqlite3)").status, "fail");
  assert.equal(r.ok, false);
});

test("MCP: missing fails; a drifted version warns and says how to re-pin (W1)", () => {
  assert.equal(find(runDoctor(env({ installedMcpVersion: () => null })), "Plaud MCP").status, "fail");
  const drift = find(runDoctor(env({ installedMcpVersion: () => "0.3.9" })), "Plaud MCP");
  assert.equal(drift.status, "warn");
  assert.match(drift.detail, /installed 0\.3\.9, pinned 0\.3\.14.*--install-mcp/);
});

test("login: missing, expired refresh, and access-expired-but-refreshable", () => {
  assert.equal(find(runDoctor(env({ readFile: () => null })), "Plaud login").status, "fail");
  const expired = runDoctor(env({ readFile: () => JSON.stringify({ refresh_token: jwt(NOW.getTime() / 1000 - 60), expires_at: 0 }) }));
  assert.equal(find(expired, "Plaud login").status, "fail");
  const refreshable = runDoctor(env({ readFile: () => JSON.stringify({ refresh_token: jwt(NOW.getTime() / 1000 + 86400), expires_at: NOW.getTime() - 1 }) }));
  assert.equal(find(refreshable, "Plaud login").status, "ok");
  assert.match(find(refreshable, "Plaud login").detail, /refreshes automatically/);
  // Never prints the token itself.
  assert.doesNotMatch(renderDoctor(refreshable), /eyJ|\.sig/);
});

test("archive on the boot volume without a backup hint warns (FR14a)", () => {
  const r = runDoctor(env({}, { archiveRoot: "/Users/owner/plaud" }));
  assert.equal(find(r, "Archive root").status, "warn");
  const ok = runDoctor(env({}, { archiveRoot: "/Users/owner/plaud", backupHint: "Time Machine + B2" }));
  assert.equal(find(ok, "Archive root").status, "ok");
  assert.equal(onBootVolume("/Volumes/X/a", "darwin"), false);
  assert.equal(onBootVolume("/Users/a", "darwin"), true);
});

test("lock: a live held lock is reported with pid/host, never broken; a leftover file is harmless", () => {
  const held = find(runDoctor(env({ probeLock: () => ({ held: true, info: { pid: 4242, host: "mac", startedAt: "2026-11-05T11:00:00Z" }, leftoverFile: false }) })), "Archive lock");
  assert.equal(held.status, "warn");
  assert.match(held.detail, /pid 4242 on mac.*never force-broken/);
  const left = find(runDoctor(env({ probeLock: () => ({ held: false, info: null, leftoverFile: true }) })), "Archive lock");
  assert.equal(left.status, "ok");
  assert.match(left.detail, /harmless/);
});

test("low disk warns", () => {
  assert.equal(find(runDoctor(env({ freeBytes: () => 2e9 })), "Disk space").status, "warn");
});
