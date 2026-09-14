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
