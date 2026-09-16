import { upsertEnvLine } from "./envFile.js";
import assert from "node:assert/strict";
import { test } from "node:test";

test("replaces an existing value in place", () => {
  const before = "PLAUD_USER_TOKEN=abc\nPLAUD_AUTH=old-value\nPLAUD_DEVICE_ID=xyz\n";
  const after = upsertEnvLine(before, "PLAUD_AUTH", "new-value");
  assert.equal(after, "PLAUD_USER_TOKEN=abc\nPLAUD_AUTH=new-value\nPLAUD_DEVICE_ID=xyz\n");
});

test("appends when the key is absent", () => {
  assert.equal(upsertEnvLine("FOO=bar\n", "PLAUD_AUTH", "v"), "FOO=bar\nPLAUD_AUTH=v\n");
  assert.equal(upsertEnvLine("", "PLAUD_AUTH", "v"), "PLAUD_AUTH=v\n");
});

test("preserves comments, blank lines and order", () => {
  const before = "# Plaud config\n\nFOO=1\nPLAUD_AUTH=old  # note\n\n# trailing comment\n";
  const after = upsertEnvLine(before, "PLAUD_AUTH", "new");
  assert.match(after, /^# Plaud config\n\nFOO=1\nPLAUD_AUTH=new\n\n# trailing comment\n$/);
});

test("handles an `export` prefix and surrounding whitespace", () => {
  assert.equal(upsertEnvLine("export PLAUD_AUTH=old\n", "PLAUD_AUTH", "new"), "PLAUD_AUTH=new\n");
  assert.equal(upsertEnvLine("  PLAUD_AUTH = old\n", "PLAUD_AUTH", "new"), "PLAUD_AUTH=new\n");
});

test("does not match a different key that merely contains the name", () => {
  // PLAUD_AUTH must not clobber PLAUD_AUTH_BACKUP or MY_PLAUD_AUTH.
  const before = "PLAUD_AUTH_BACKUP=keep\nMY_PLAUD_AUTH=keep\n";
  const after = upsertEnvLine(before, "PLAUD_AUTH", "new");
  assert.match(after, /PLAUD_AUTH_BACKUP=keep/);
  assert.match(after, /MY_PLAUD_AUTH=keep/);
  assert.match(after, /^PLAUD_AUTH=new$/m);
});

test("replaces only the first occurrence if a key is duplicated", () => {
  const after = upsertEnvLine("PLAUD_AUTH=one\nPLAUD_AUTH=two\n", "PLAUD_AUTH", "new");
  assert.equal(after, "PLAUD_AUTH=new\nPLAUD_AUTH=two\n");
});
