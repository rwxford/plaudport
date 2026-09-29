import { ImportArgsError, parseImportArgs } from "./importArgs.js";
import assert from "node:assert/strict";
import { test } from "node:test";

const LINK = "https://web.plaud.ai/s/pub_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa::tok1";
const exists = (files: string[]) => (p: string) => files.includes(p);

test("tells links, recordings and link lists apart without being told", () => {
  const r = parseImportArgs([LINK, "call.mp4", "links.txt", "pub_x::y"], exists(["call.mp4", "links.txt"]));
  assert.deepEqual(r.entries, [
    { kind: "link", value: LINK },
    { kind: "media", value: "call.mp4" },
    { kind: "list", value: "links.txt" },
    { kind: "link", value: "pub_x::y" },
  ]);
});

test("Gong's download formats count as recordings, whatever the case", () => {
  const r = parseImportArgs(["a.MP4", "b.wav", "c.m4a"], exists(["a.MP4", "b.wav", "c.m4a"]));
  assert.ok(r.entries.every((e) => e.kind === "media"));
});

test("reads --title and --date, in either spelling", () => {
  const spaced = parseImportArgs(["call.mp4", "--title", "Acme discovery", "--date", "2026-09-20 14:00"], exists(["call.mp4"]));
  assert.equal(spaced.title, "Acme discovery");
  assert.equal(spaced.date, "2026-09-20 14:00");
  const inline = parseImportArgs(["--title=Acme", "call.mp4"], exists(["call.mp4"]));
  assert.equal(inline.title, "Acme");
  // The value after --title must not be mistaken for a file to import.
  assert.equal(spaced.entries.length, 1);
});

test("switches", () => {
  const r = parseImportArgs([LINK, "--fetch-only", "--force"], exists([]));
  assert.equal(r.fetchOnly, true);
  assert.equal(r.extraCopy, true);
});

test("--title and --date need exactly one recording", () => {
  assert.throws(() => parseImportArgs([LINK, "--title", "x"], exists([])), ImportArgsError);
  assert.throws(() => parseImportArgs(["a.mp4", "b.mp4", "--date", "2026-09-20"], exists(["a.mp4", "b.mp4"])), ImportArgsError);
  assert.throws(() => parseImportArgs(["a.mp4", LINK, "--title", "x"], exists(["a.mp4"])), ImportArgsError);
});

test("a missing file is an error, worded for what it looked like", () => {
  assert.throws(() => parseImportArgs(["call.mp4"], exists([])), /No such file: call\.mp4/);
  assert.throws(() => parseImportArgs(["linkz.txt"], exists([])), /Not a share link, and no such file/);
});

test("a typo'd option is refused rather than ignored", () => {
  assert.throws(() => parseImportArgs([LINK, "--fetchonly"], exists([])), /Unknown option --fetchonly/);
  assert.throws(() => parseImportArgs(["call.mp4", "--title"], exists(["call.mp4"])), /needs a value/);
});
