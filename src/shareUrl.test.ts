import { describeShare, parseShareUrl, ShareUrlError } from "./shareUrl.js";
import assert from "node:assert/strict";
import { test } from "node:test";

const ID = "pub_b42cf8f6-fd60-44dc-a73d-af2d3c0bde18";
const TOKEN = "tkE4xwy3GokAK0yEmRoDApgC4bGVaYSHIJx3KIa9-Vvv-_JaBmkx-_2TL2W-lGxE4Prt_VH1rzlRuk4C";
const URL_ = `https://web.plaud.ai/s/${ID}::${TOKEN}`;

test("parses a full share URL", () => {
  const ref = parseShareUrl(URL_);
  assert.equal(ref.shareId, ID);
  assert.equal(ref.accessToken, TOKEN);
  assert.equal(ref.host, "web.plaud.ai");
  assert.equal(ref.url, URL_);
});

test("parses a bare id::token pair", () => {
  const ref = parseShareUrl(`${ID}::${TOKEN}`);
  assert.equal(ref.shareId, ID);
  assert.equal(ref.accessToken, TOKEN);
});

test("tolerates whitespace, trailing slash, query and fragment", () => {
  assert.equal(parseShareUrl(`  ${URL_}  `).shareId, ID);
  assert.equal(parseShareUrl(`${URL_}/`).accessToken, TOKEN);
  assert.equal(parseShareUrl(`${URL_}?utm_source=slack`).accessToken, TOKEN);
  assert.equal(parseShareUrl(`${URL_}#top`).accessToken, TOKEN);
});

test("tolerates percent-encoded colons", () => {
  assert.equal(parseShareUrl(`https://web.plaud.ai/s/${ID}%3A%3A${TOKEN}`).accessToken, TOKEN);
});

test("rejects a non-Plaud host", () => {
  assert.throws(() => parseShareUrl(`https://evil.example.com/s/${ID}::${TOKEN}`), ShareUrlError);
});

test("rejects a link with no separator", () => {
  assert.throws(() => parseShareUrl(`https://web.plaud.ai/s/${ID}`), ShareUrlError);
});

test("rejects a malformed share id", () => {
  assert.throws(() => parseShareUrl(`https://web.plaud.ai/s/notapub::${TOKEN}`), ShareUrlError);
});

test("rejects a truncated token", () => {
  assert.throws(() => parseShareUrl(`${ID}::short`), ShareUrlError);
});

test("describeShare never prints the whole token", () => {
  const out = describeShare(parseShareUrl(URL_));
  assert.ok(!out.includes(TOKEN), "full token must not appear");
  assert.ok(out.includes(ID), "share id should appear");
});
