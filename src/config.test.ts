import { hostnameOf, isAllowedHost } from "./config.js";
import assert from "node:assert/strict";
import { test } from "node:test";

// These run against the default allowlist: web.plaud.ai, api.plaud.ai.

test("hostnameOf strips ports", () => {
  assert.equal(hostnameOf("web.plaud.ai"), "web.plaud.ai");
  assert.equal(hostnameOf("127.0.0.1:8731"), "127.0.0.1");
  assert.equal(hostnameOf("WEB.PLAUD.AI:443"), "web.plaud.ai");
});

test("hostnameOf keeps IPv6 literals intact", () => {
  assert.equal(hostnameOf("[::1]:8080"), "[::1]");
  assert.equal(hostnameOf("[::1]"), "[::1]");
});

test("allows exact and subdomain matches", () => {
  assert.ok(isAllowedHost("web.plaud.ai"));
  assert.ok(isAllowedHost("api.plaud.ai"));
  assert.ok(isAllowedHost("cdn.api.plaud.ai"), "subdomains of an allowed host are allowed");
});

test("a port does not defeat the allowlist", () => {
  // URL.host includes the port; the allowlist holds hostnames. Regression test
  // for a real bug where any host:port was refused even when allowed.
  assert.ok(isAllowedHost("web.plaud.ai:443"));
  assert.ok(isAllowedHost("web.plaud.ai:8443"));
});

test("rejects lookalike and unrelated hosts", () => {
  assert.equal(isAllowedHost("evil.example.com"), false);
  assert.equal(isAllowedHost("notplaud.ai"), false);
  assert.equal(isAllowedHost("web.plaud.ai.evil.com"), false, "suffix must be a real domain boundary");
  assert.equal(isAllowedHost("xweb.plaud.ai"), false, "matching is on the dot boundary, not raw substring");
});

// --- v2 pipeline settings (P0-PLAN T1) ---------------------------------------
import { defaultMcpDir, parsePipelineSettings, PLAUD_MCP_PINNED_VERSION } from "./config.js";
import { spawnSync } from "node:child_process";

test("pipeline defaults match PRD §13", () => {
  const r = parsePipelineSettings({});
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.config.archiveRoot, "./data/archive");
  assert.equal(r.config.overlapDays, 14);
  assert.equal(r.config.textTimeoutDays, 7);
  assert.equal(r.config.retryReportAfter, 3);
  assert.equal(r.config.textChecksPerRun, 200);
  assert.equal(r.config.revisionHistory, 3);
  assert.equal(r.config.backupHint, "");
  assert.equal(r.config.mcpVersion, PLAUD_MCP_PINNED_VERSION);
  assert.equal(r.config.debugUrlAgeHours, null);
  assert.ok(r.config.mcpDir.length > 0);
});

test("pipeline settings accept overrides within bounds", () => {
  const r = parsePipelineSettings({
    PLAUDPORT_PULL_OVERLAP_DAYS: "30",
    PLAUDPORT_REVISION_HISTORY: "5",
    PLAUDPORT_ARCHIVE_ROOT: "/Volumes/Archive/plaud",
    PLAUD_MCP_PACKAGE_VERSION: "0.4.0",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.config.overlapDays, 30);
  assert.equal(r.config.revisionHistory, 5);
  assert.equal(r.config.archiveRoot, "/Volumes/Archive/plaud");
  assert.equal(r.config.mcpVersion, "0.4.0");
});

test("pipeline settings reject nonsense", () => {
  for (const env of [
    { PLAUDPORT_PULL_OVERLAP_DAYS: "0" },
    { PLAUDPORT_PULL_OVERLAP_DAYS: "abc" },
    { PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS: "-1" },
    { PLAUDPORT_REVISION_HISTORY: "1.5" },
    { PLAUDPORT_TEXT_CHECKS_PER_RUN: "0" },
    { PLAUD_MCP_PACKAGE_VERSION: "^0.3.14" },
    { PLAUD_MCP_PACKAGE_VERSION: "latest" },
    { PLAUDPORT_ARCHIVE_ROOT: "" },
  ]) {
    assert.equal(parsePipelineSettings(env).ok, false, JSON.stringify(env));
  }
});

test("default MCP install dir is per-platform", () => {
  assert.match(defaultMcpDir("darwin", "/Users/x"), /Library\/Application Support\/PlaudPort\/mcp$/);
  assert.match(defaultMcpDir("linux", "/home/x"), /\.local\/share\/plaudport\/mcp$/);
});

test("the default archive root is gitignored (W3)", () => {
  const r = spawnSync("git", ["check-ignore", "-q", "data/archive/2026/11/of_x/manifest.json"]);
  assert.equal(r.status, 0, "data/archive/** must be ignored by git");
  const l = spawnSync("git", ["check-ignore", "-q", "data/archive/.plaudport/ledger.sqlite"]);
  assert.equal(l.status, 0);
});
