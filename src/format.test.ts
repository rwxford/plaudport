import { detailToMarkdown, humanDuration, outlineToText, slugify, timecode, transcriptToText } from "./format.js";
import assert from "node:assert/strict";
import { test } from "node:test";

test("timecode formats millisecond offsets", () => {
  assert.equal(timecode(0), "0:00");
  assert.equal(timecode(5_000), "0:05");
  assert.equal(timecode(635_000), "10:35"); // the real example's length
  assert.equal(timecode(3_725_000), "1:02:05");
});

test("timecode survives missing or nonsense values", () => {
  assert.equal(timecode(undefined), "--:--");
  assert.equal(timecode(-1), "--:--");
  assert.equal(timecode(Number.NaN), "--:--");
});

test("humanDuration reads like a person wrote it", () => {
  assert.equal(humanDuration(635_000), "10m 35s");
  assert.equal(humanDuration(3_725_000), "1h 02m");
  assert.equal(humanDuration(9_000), "9s");
  assert.equal(humanDuration(undefined), "unknown length");
});

test("transcript renders one line per utterance with speaker and time", () => {
  const out = transcriptToText([
    { start_time: 0, speaker: "Ross", content: "morning" },
    { start_time: 62_000, speaker: "Sam", content: "  spaced  " },
  ]);
  assert.equal(out, "[0:00] Ross: morning\n[1:02] Sam: spaced");
});

test("transcript falls back when a speaker is unnamed", () => {
  const out = transcriptToText([{ start_time: 0, original_speaker: "SPEAKER_01", content: "hi" }]);
  assert.match(out, /SPEAKER_01: hi/);
  assert.equal(transcriptToText([{ start_time: 0, content: "hi" }]), "[0:00] Speaker: hi");
});

test("empty transcript produces nothing, not a header with no body", () => {
  assert.equal(transcriptToText(undefined), "");
  assert.equal(transcriptToText([]), "");
  assert.equal(outlineToText([]), "");
});

test("markdown archive includes what the share exposed", () => {
  const md = detailToMarkdown(
    {
      owner_name: "Someone",
      data_file: {
        filename: "Weekly sync",
        start_time: 1_789_402_715_000,
        duration: 635_000,
        file_language: "en",
        trans_result: [{ start_time: 0, speaker: "A", content: "raw line" }],
        transaction_polish: [{ start_time: 0, speaker: "A", content: "polished line" }],
        outline_result: [{ start_time: 0, topic: "Kickoff" }],
        notes_list: [{ data_title: "Summary", data_content: "It happened." }],
      },
    },
    "pub_demo",
  );
  assert.match(md, /^# Weekly sync/);
  assert.match(md, /10m 35s/);
  assert.match(md, /## Summary[\s\S]*It happened\./);
  assert.match(md, /## Outline[\s\S]*Kickoff/);
  assert.match(md, /## Transcript \(AI-polished\)[\s\S]*polished line/);
  assert.match(md, /## Transcript \(original\)[\s\S]*raw line/);
});

test("markdown omits sections the share didn't include", () => {
  const md = detailToMarkdown({ data_file: { filename: "Bare" } }, "pub_demo");
  assert.ok(!md.includes("## Outline"));
  assert.ok(!md.includes("## Transcript"));
  assert.match(md, /unknown length/);
});

test("slugify keeps titles safe as folder names", () => {
  assert.equal(slugify("Weekly Sync — Q3 Planning!"), "weekly-sync-q3-planning");
  assert.equal(slugify("../../etc/passwd"), "etcpasswd", "no path traversal from a hostile title");
  assert.equal(slugify(""), "recording");
  assert.equal(slugify(undefined), "recording");
  assert.ok(slugify("x".repeat(200)).length <= 60);
});

test("slugify cuts long titles at a word boundary, not mid-word", () => {
  const slug = slugify("09-14 Meeting: GDA Funding Delays, License Updates, and Contract Extension");
  assert.ok(slug.length <= 60);
  assert.ok(!slug.endsWith("-"), "no trailing separator");
  assert.equal(slug, "09-14-meeting-gda-funding-delays-license-updates-and");
  // A single very long word has no boundary to cut on; it must not vanish.
  assert.equal(slugify("supercalifragilisticexpialidocious".repeat(3)).length, 60);
});
