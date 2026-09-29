import { convertToMp3, isMediaPath, localArchiveDirName, MediaError, parseWhen, probeMedia } from "./localMedia.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a bare date is local midnight, not UTC midnight", () => {
  // UTC midnight is the previous evening in the Americas: the call would land
  // in Plaud a day early.
  const ms = parseWhen("2026-09-20");
  const d = new Date(ms);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 8, 20, 0]);
});

test("a date and time is local time, with a space or a T", () => {
  for (const s of ["2026-09-20 14:30", "2026-09-20T14:30", "2026-09-20 14:30:00"]) {
    const d = new Date(parseWhen(s));
    assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [20, 14, 30], s);
  }
});

test("an explicit zone is honoured exactly", () => {
  assert.equal(parseWhen("2026-09-20T14:30:00Z"), Date.UTC(2026, 8, 20, 14, 30));
  assert.equal(parseWhen("2026-09-20T14:30:00-04:00"), Date.UTC(2026, 8, 20, 18, 30));
});

test("impossible or unreadable dates are refused, not rolled over", () => {
  for (const s of ["2026-02-31", "2026-13-01", "2026-09-20 25:00", "Sept 20", "20/09/2026", ""]) {
    assert.throws(() => parseWhen(s), MediaError, s);
  }
});

test("recognises recording extensions, case-insensitively", () => {
  for (const p of ["a.mp3", "b.MP4", "c.wav", "d.m4a", "e.mov", "dir.with.dots/f.webm"]) assert.ok(isMediaPath(p), p);
  for (const p of ["links.txt", "notes", "x.mp3.txt"]) assert.ok(!isMediaPath(p), p);
});

test("archive folders lead with the checksum, so a renamed file finds its old folder", () => {
  const sha = "0123456789abcdef".repeat(4);
  assert.equal(localArchiveDirName(sha, "Acme: discovery call"), "0123456789ab-acme-discovery-call");
});

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"]).error;

test("converts a WAV to a real MP3 of the same length", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "plaudport-"));
  try {
    const wav = join(dir, "in.wav");
    const mp3 = join(dir, "out.mp3");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav]);
    convertToMp3(wav, mp3);
    const head = readFileSync(mp3).subarray(0, 3);
    // An MP3 starts with an ID3 tag or an MPEG frame sync.
    assert.ok(head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0));
    assert.ok(!existsSync(`${mp3}.partial`), "temp file cleaned up");
    const seconds = (probeMedia(mp3)?.durationMs ?? 0) / 1000;
    assert.ok(Math.abs(seconds - 3) < 0.2, `duration ${seconds}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a video with no audio track fails clearly", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "plaudport-"));
  try {
    const mp4 = join(dir, "silent.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-pix_fmt", "yuv420p", mp4]);
    assert.throws(() => convertToMp3(mp4, join(dir, "out.mp3")), /no audio track/);
    assert.ok(!existsSync(join(dir, "out.mp3")) && !existsSync(join(dir, "out.mp3.partial")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
