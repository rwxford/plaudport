import { parseEnv } from "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";

test("parses plain assignments", () => {
  assert.deepEqual(parseEnv("FOO=bar\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
});

test("ignores comments and blank lines", () => {
  assert.deepEqual(parseEnv("# a comment\n\nFOO=bar\n   \n# another"), { FOO: "bar" });
});

test("handles quotes and an `export` prefix", () => {
  assert.deepEqual(parseEnv(`export FOO="bar baz"\nBAZ='single'`), { FOO: "bar baz", BAZ: "single" });
});

test("keeps characters that appear in real tokens", () => {
  // Tokens carry =, -, _, . and / — none of which may be treated as delimiters
  // beyond the first equals sign. (Deliberately not JWT-shaped: the secret
  // check would flag a realistic-looking one, and rightly so.)
  const token = "AAAA.BBBB-CCCC_DDDD/EEEE==";
  assert.deepEqual(parseEnv(`PLAUD_USER_TOKEN=${token}`), { PLAUD_USER_TOKEN: token });
});

test("strips a trailing comment only when unquoted", () => {
  assert.deepEqual(parseEnv("FOO=bar # trailing"), { FOO: "bar" });
  assert.deepEqual(parseEnv('FOO="bar # not a comment"'), { FOO: "bar # not a comment" });
});

test("skips malformed lines rather than inventing keys", () => {
  assert.deepEqual(parseEnv("just-a-line\n=novalue\n9BAD=x\nGOOD=y"), { GOOD: "y" });
});

test("an empty value is kept, since it means 'not filled in'", () => {
  assert.deepEqual(parseEnv("PLAUD_TOKEN="), { PLAUD_TOKEN: "" });
});
