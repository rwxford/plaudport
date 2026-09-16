import { parseLinkList } from "./linkList.js";
import assert from "node:assert/strict";
import { test } from "node:test";

const A = "https://web.plaud.ai/s/pub_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa::tok1";
const B = "https://web.plaud.ai/s/pub_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb::tok2";

test("reads one link per line", () => {
  assert.deepEqual(parseLinkList(`${A}\n${B}`), [A, B]);
});

test("ignores blank lines and comments, so the file can hold notes", () => {
  assert.deepEqual(parseLinkList(`# Monday's calls\n\n${A}\n\n#${B}\n${B}\n`), [A, B]);
});

test("tolerates a pasted numbered or bulleted list", () => {
  assert.deepEqual(parseLinkList(`1. ${A}\n2) ${B}`), [A, B]);
  assert.deepEqual(parseLinkList(`- ${A}\n* ${B}`), [A, B]);
});

test("trims stray whitespace", () => {
  assert.deepEqual(parseLinkList(`  ${A}  \n\t${B}\t`), [A, B]);
});

test("an empty or comment-only file yields nothing", () => {
  assert.deepEqual(parseLinkList(""), []);
  assert.deepEqual(parseLinkList("# just notes\n\n   \n"), []);
});
