import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "plaudport.mjs");

// Mirrors an installed copy (Homebrew/npm link): the launcher lives elsewhere
// and is run from an unrelated folder, so a bare `--import tsx` can't resolve.
function runFrom(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAUD_")));
  return spawnSync(process.execPath, [launcher, ...args], { cwd, env, encoding: "utf8" });
}

test("launcher starts the CLI from a cwd outside the repo (tsx resolves from the install)", () => {
  const dir = mkdtempSync(join(tmpdir(), "plaudport-launcher-"));
  try {
    const res = runFrom(dir, "--version");
    assert.doesNotMatch(res.stderr, /ERR_MODULE_NOT_FOUND|tsx/);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /plaudport \d+\.\d+\.\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher leaves the caller's cwd alone (.env is read from where it was run)", () => {
  const dir = mkdtempSync(join(tmpdir(), "plaudport-launcher-"));
  try {
    writeFileSync(join(dir, ".env"), "PLAUD_DEVICE_ID=launchercwdmarker99\n");
    const res = runFrom(dir, "check-auth");
    assert.doesNotMatch(res.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(res.stdout, /laun…er99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
