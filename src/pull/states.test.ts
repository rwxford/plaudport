import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTIFACTS } from "../archive/manifest.js";
import {
  applyTextCheck,
  audioDue,
  backoffMs,
  DAY_MS,
  deriveBundle,
  HOUR_MS,
  initialArtifacts,
  initialAudio,
  jitteredBackoffMs,
  nextAudio,
  pastTextDeadline,
  reopenAbsent,
  urlNeedsRefresh,
} from "./states.js";

// P0-PLAN T4 (FR1b, FR1c; C2).

const now = new Date("2026-11-05T12:00:00Z");

test("audio: pending → ok on a verified download", () => {
  const s = nextAudio(initialAudio(), { kind: "download_ok" }, now);
  assert.equal(s.state, "audio_ok");
  assert.equal(audioDue(s, now), false);
});

test("audio: a failure counts an attempt and schedules a retry; never gives up", () => {
  let s = initialAudio();
  for (let i = 1; i <= 20; i++) {
    s = nextAudio(s, { kind: "download_failed", errorClass: "http_500" }, now, 0.5);
    assert.equal(s.state, "audio_failed");
    assert.equal(s.attempts, i);
    assert.equal(audioDue(s, now), false, "not due before next_retry_at");
    assert.equal(audioDue(s, new Date(Date.parse(s.nextRetryAt!))), true, "due at next_retry_at");
  }
  s = nextAudio(s, { kind: "download_ok" }, now);
  assert.equal(s.state, "audio_ok");
  assert.equal(s.lastErrorClass, null);
});

test("audio: an expired URL is NOT an attempt and does not move the state", () => {
  const s0 = initialAudio();
  assert.deepEqual(nextAudio(s0, { kind: "url_expired" }, now), s0);
  const f = nextAudio(s0, { kind: "download_failed", errorClass: "x" }, now, 0.5);
  assert.deepEqual(nextAudio(f, { kind: "url_expired" }, now), f);
});

test("audio: a verified download never regresses", () => {
  const ok = nextAudio(initialAudio(), { kind: "download_ok" }, now);
  assert.deepEqual(nextAudio(ok, { kind: "download_failed", errorClass: "x" }, now), ok);
});

test("backoff: min(2^n × 15 min, 24 h) with ±20% jitter", () => {
  assert.equal(backoffMs(0), 15 * 60_000);
  assert.equal(backoffMs(1), 30 * 60_000);
  assert.equal(backoffMs(3), 120 * 60_000);
  assert.equal(backoffMs(7), DAY_MS);
  assert.equal(backoffMs(50), DAY_MS, "capped");
  for (const n of [0, 1, 4, 10]) {
    const b = backoffMs(n);
    assert.equal(jitteredBackoffMs(n, 0), Math.round(b * 0.8));
    assert.equal(jitteredBackoffMs(n, 0.5), b);
    assert.ok(jitteredBackoffMs(n, 0.9999) <= Math.round(b * 1.2));
  }
});

test("url freshness: refresh at ≥ 23 h, and the debug override forces it (G3a)", () => {
  assert.equal(urlNeedsRefresh(new Date(now.getTime() - 22 * HOUR_MS).toISOString(), now), false);
  assert.equal(urlNeedsRefresh(new Date(now.getTime() - 23 * HOUR_MS).toISOString(), now), true);
  assert.equal(urlNeedsRefresh(now.toISOString(), now, 25), true);
  assert.equal(urlNeedsRefresh(now.toISOString(), now, 1), false);
});

test("text deadline: strictly greater than the timeout", () => {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  assert.equal(pastTextDeadline(since, now, 7), false, "exactly at the boundary is still within");
  assert.equal(pastTextDeadline(since, new Date(now.getTime() + 1), 7), true);
  assert.equal(pastTextDeadline(null, now, 7), false);
});

test("per-artifact: each resolves on its own; one arrival does not freeze the rest (C2)", () => {
  let a = initialArtifacts();
  a = applyTextCheck(a, { pastDeadline: false, observed: { transcript: true }, presentRev: "rev-0002" }, now);
  assert.equal(a.transcript.state, "present");
  assert.equal(a.transcript.presentRev, "rev-0002");
  for (const k of ["polish", "outline", "highlights", "note"] as const) {
    assert.equal(a[k].state, "pending");
    assert.equal(a[k].lastCheckedAt, now.toISOString());
  }
  assert.equal(deriveBundle(a), "plaud_text_pending");

  a = applyTextCheck(a, { pastDeadline: false, observed: { note: true, transcript: false }, presentRev: "rev-0003" }, now);
  assert.equal(a.note.state, "present");
  assert.equal(a.transcript.presentRev, "rev-0002", "an already-present artifact never changes");
});

test("past the deadline, pending artifacts become absent without a fetch (R2-2)", () => {
  let a = initialArtifacts();
  a = applyTextCheck(a, { pastDeadline: false, observed: { transcript: true }, presentRev: "rev-0002" }, now);
  a = applyTextCheck(a, { pastDeadline: true }, now);
  assert.equal(a.transcript.state, "present");
  for (const k of ["polish", "outline", "highlights", "note"] as const) assert.equal(a[k].state, "absent");
  assert.equal(deriveBundle(a), "plaud_text_ok");
});

test("bundle: ok only when all present-or-absent; absent only when all absent", () => {
  const all = (state: "pending" | "present" | "absent") =>
    Object.fromEntries(ARTIFACTS.map((k) => [k, { state, lastCheckedAt: null, presentRev: null }])) as ReturnType<typeof initialArtifacts>;
  assert.equal(deriveBundle(all("pending")), "plaud_text_pending");
  assert.equal(deriveBundle(all("present")), "plaud_text_ok");
  assert.equal(deriveBundle(all("absent")), "plaud_text_absent");
  const mixed = all("absent");
  mixed.highlights = { state: "present", lastCheckedAt: null, presentRev: "rev-0002" };
  assert.equal(deriveBundle(mixed), "plaud_text_ok");
  mixed.note = { state: "pending", lastCheckedAt: null, presentRev: null };
  assert.equal(deriveBundle(mixed), "plaud_text_pending");
});

test("--recheck-text reopens only absent artifacts", () => {
  let a = initialArtifacts();
  a = applyTextCheck(a, { pastDeadline: false, observed: { transcript: true }, presentRev: "rev-0002" }, now);
  a = applyTextCheck(a, { pastDeadline: true }, now);
  const r = reopenAbsent(a);
  assert.equal(r.transcript.state, "present");
  assert.equal(r.note.state, "pending");
  assert.equal(deriveBundle(r), "plaud_text_pending");
});
