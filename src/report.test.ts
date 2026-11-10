import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { absDir, AUDIO, ledgerPath } from "./archive/layout.js";
import { ArchiveLock } from "./archive/lock.js";
import { commitManifest, initializeRecording, sha256 } from "./archive/revision.js";
import { Ledger } from "./ledger/db.js";
import { sweepArchive } from "./ledger/sweep.js";
import { nextAudio } from "./pull/states.js";
import { buildReport, percentiles, renderReport } from "./report.js";
import { initInput, tempRoot } from "./testing/fixtures.js";

// P0-PLAN T9 (FR22 partial, §13 calibration readouts).

function archive() {
  const root = tempRoot();
  const lock = ArchiveLock.tryAcquire(root)!;
  const now = new Date("2026-11-05T12:00:00Z");
  // Plaud created_at − start_at: 0 h, 24 h, 192 h (the F5 8-day case).
  const specs = [
    { n: 1, start: "2026-11-04T09:00:00.000Z", created: "2026-11-04T09:00:00.000Z" },
    { n: 2, start: "2026-11-03T09:00:00.000Z", created: "2026-11-04T09:00:00.000Z" },
    { n: 3, start: "2026-10-27T09:00:00.000Z", created: "2026-11-04T09:00:00.000Z" },
  ];
  const rels: string[] = [];
  for (const s of specs) {
    const inp = initInput(s.n, now, s.start);
    inp.facts.createdAt = s.created;
    let m = initializeRecording(root, inp);
    const dir = absDir(root, inp.rel);
    if (s.n === 1) {
      writeFileSync(join(dir, AUDIO), "audio-bytes");
      m = { ...m, audio: { file: AUDIO, bytes: 11, sha256: sha256("audio-bytes"), fetchedAt: now.toISOString() }, states: { ...m.states, audio: nextAudio(m.states.audio, { kind: "download_ok" }, now) } };
    } else {
      let a = m.states.audio;
      for (let i = 0; i < 4; i++) a = nextAudio(a, { kind: "download_failed", errorClass: "http_500" }, now, 0.5);
      m = { ...m, states: { ...m.states, audio: a } };
    }
    commitManifest(dir, m);
    rels.push(inp.rel);
  }
  const l = new Ledger(ledgerPath(root));
  sweepArchive(root, l, lock, { now });
  l.close();
  lock.release();
  return { root, rels };
}

const base = { retryReportAfter: 3, overlapDays: 14, textTimeoutDays: 7 };

test("percentiles", () => {
  assert.deepEqual(percentiles([]), { n: 0, max: null, p95: null, median: null });
  const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(p.max, 100);
  assert.equal(p.p95, 95);
  assert.equal(p.median, 50);
});

test("report counts states, escalations and error classes — and carries no ids or titles when redacted", async () => {
  const { root } = archive();
  const r = (await buildReport(root, { ...base, lag: true }))!;
  assert.equal(r.recordings, 3);
  assert.deepEqual(r.audio, { audio_failed: 2, audio_ok: 1 });
  assert.equal(r.escalated.count, 2);
  assert.equal(r.escalated.ids, undefined);
  assert.deepEqual(r.errorClasses, { http_500: 2 });
  const text = renderReport(r) + JSON.stringify(r);
  assert.doesNotMatch(text, /of_fake|Synthetic/);
  const open = (await buildReport(root, { ...base, revealIds: true }))!;
  assert.equal(open.escalated.ids?.length, 2);
});

test("--lag: max/p95 lag and the implied window (2 × max created − start)", async () => {
  const { root } = archive();
  const r = (await buildReport(root, { ...base, lag: true }))!;
  assert.equal(r.lag!.createdMinusStartHours.max, 192);
  assert.equal(r.lag!.createdMinusStartHours.n, 3);
  assert.equal(r.lag!.impliedOverlapDays, 16);
  assert.equal(r.lag!.firstSeenMinusStartHours.max, 219); // 2026-10-27T09 → 2026-11-05T12
});

test("--verify-audio re-hashes a sample and reports mismatches", async () => {
  const { root, rels } = archive();
  let r = (await buildReport(root, { ...base, verifyAudio: 20 }))!;
  assert.deepEqual(r.audioVerify, { sampled: 1, ok: 1, mismatched: 0, missing: 0 });
  writeFileSync(join(absDir(root, rels[0]!), AUDIO), "tampered");
  r = (await buildReport(root, { ...base, verifyAudio: 20 }))!;
  assert.equal(r.audioVerify!.mismatched, 1);
});

test("no ledger yet → null", async () => {
  assert.equal(await buildReport(tempRoot(), base), null);
});
