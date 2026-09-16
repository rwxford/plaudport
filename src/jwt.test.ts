import { describeGap, readTokenExpiry } from "./jwt.js";
import assert from "node:assert/strict";
import { test } from "node:test";

/** Build a JWT-shaped string with the given payload. Signature is never checked. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.notarealsignature`;
}

const NOW = Date.parse("2026-09-16T12:00:00Z");

test("reads an expiry in the future", () => {
  const token = fakeJwt({ exp: NOW / 1000 + 3 * 3600 });
  const info = readTokenExpiry(token, NOW)!;
  assert.equal(info.expired, false);
  assert.equal(info.relative, "in 3h");
});

test("reads an expiry in the past", () => {
  // The real case: a token copied yesterday, used today.
  const info = readTokenExpiry(fakeJwt({ exp: NOW / 1000 - 26 * 3600 }), NOW)!;
  assert.equal(info.expired, true);
  assert.equal(info.relative, "1d 2h ago");
});

test("tolerates a Bearer prefix", () => {
  const info = readTokenExpiry(`Bearer ${fakeJwt({ exp: NOW / 1000 + 60 })}`, NOW)!;
  assert.equal(info.expired, false);
});

test("returns null for anything that isn't a JWT with an exp", () => {
  assert.equal(readTokenExpiry("not-a-jwt", NOW), null);
  assert.equal(readTokenExpiry("a.b.c", NOW), null, "three segments but not decodable");
  assert.equal(readTokenExpiry(fakeJwt({ sub: "user" }), NOW), null, "no exp claim");
  assert.equal(readTokenExpiry(fakeJwt({ exp: "soon" }), NOW), null, "exp must be numeric");
  assert.equal(readTokenExpiry("", NOW), null);
});

test("describeGap reads like a person wrote it", () => {
  assert.equal(describeGap(3 * 3600_000 + 20 * 60_000), "in 3h 20m");
  assert.equal(describeGap(-45 * 60_000), "45m ago");
  assert.equal(describeGap(30_000), "in under a minute");
});
