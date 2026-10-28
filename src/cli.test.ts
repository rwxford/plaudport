import { COMMANDS, resolveCommand, SCRIPTS, SUMMARIES, usage } from "./cli.js";
import assert from "node:assert/strict";
import { test } from "node:test";

test("help is the default and the explicit forms", () => {
  for (const c of [undefined, "", "help", "-h", "--help"]) assert.equal(resolveCommand(c).kind, "help");
});

test("version flags resolve to version", () => {
  for (const c of ["-v", "--version", "version"]) assert.equal(resolveCommand(c).kind, "version");
});

test("each command maps to its module or script", () => {
  assert.deepEqual(resolveCommand("import"), { kind: "module", spec: "./importBatch.js" });
  assert.deepEqual(resolveCommand("web"), { kind: "module", spec: "./webServer.js" });
  assert.deepEqual(resolveCommand("chrome-install"), { kind: "script", spec: "../scripts/chrome-auth-install.mjs" });
});

test("npm-script spellings with colons still work", () => {
  assert.deepEqual(resolveCommand("set:auth"), { kind: "module", spec: "./setAuth.js" });
  assert.deepEqual(resolveCommand("chrome:install"), { kind: "script", spec: "../scripts/chrome-auth-install.mjs" });
});

test("an unrecognised word is unknown, carrying what was typed", () => {
  assert.deepEqual(resolveCommand("frobnicate"), { kind: "unknown", cmd: "frobnicate" });
  assert.deepEqual(resolveCommand("nope"), { kind: "unknown", cmd: "nope" });
});

test("every command and script has a one-line summary, and usage lists them", () => {
  const u = usage();
  for (const c of [...Object.keys(COMMANDS), ...Object.keys(SCRIPTS)]) {
    assert.ok(SUMMARIES[c], `missing summary for ${c}`);
  }
  for (const c of ["import", "web", "set-auth", "check-auth", "chrome-install"]) {
    assert.ok(u.includes(`plaudport ${c}`), `usage should mention ${c}`);
  }
});
