import { parseCurl, tokenizeShell } from "./curl.js";
import assert from "node:assert/strict";
import { test } from "node:test";

// Shaped like what Chrome actually puts on the clipboard.
const CHROME_CURL = `curl 'https://api.plaud.ai/user/login' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'authorization: Bearer eyJfake' \\
  -H 'content-type: application/json' \\
  -b 'session=abc; other=def' \\
  --data-raw '{"email":"someone@example.com","password":"hunter2"}' \\
  --compressed`;

test("parses a Chrome Copy-as-cURL command", () => {
  const parsed = parseCurl(CHROME_CURL);
  assert.equal(parsed.url, "https://api.plaud.ai/user/login");
  assert.equal(parsed.method, "POST", "a body implies POST when -X is absent");
  assert.ok(parsed.headerNames.includes("authorization"));
  assert.equal(parsed.hasCookie, true);
  assert.equal(parsed.body, '{"email":"someone@example.com","password":"hunter2"}');
});

test("honours an explicit -X", () => {
  assert.equal(parseCurl("curl -X PUT 'https://x.plaud.ai/a'").method, "PUT");
  assert.equal(parseCurl("curl 'https://x.plaud.ai/a'").method, "GET");
});

test("tokenizer keeps quoted spaces together and drops line continuations", () => {
  assert.deepEqual(tokenizeShell(`curl 'a b' \\\n  -H "c: d e"`), ["curl", "a b", "-H", "c: d e"]);
});

test("tokenizer preserves an empty quoted argument", () => {
  assert.deepEqual(tokenizeShell(`curl '' -d ''`), ["curl", "", "-d", ""]);
});

test("rejects anything that isn't a curl command", () => {
  assert.throws(() => parseCurl("wget https://example.com"), /does not start with "curl"/);
  assert.throws(() => parseCurl("curl --compressed"), /No URL found/);
});

test("header names are lowercased so lookups are predictable", () => {
  const parsed = parseCurl(`curl 'https://x.plaud.ai/a' -H 'X-Pld-User: abc'`);
  assert.deepEqual(parsed.headerNames, ["x-pld-user"]);
});
