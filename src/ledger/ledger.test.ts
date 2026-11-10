import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { absDir, ledgerPath, MANIFEST } from "../archive/layout.js";
import { ArchiveLock } from "../archive/lock.js";
import { commitManifest, initializeRecording, readRecording, withRevision, writeRevision } from "../archive/revision.js";
import { nextAudio, applyTextCheck, deriveBundle } from "../pull/states.js";
import { initInput, tempRoot } from "../testing/fixtures.js";
import { Ledger } from "./db.js";
import { rebuildIndex, sweepArchive } from "./sweep.js";

// P0-PLAN T3 (FR14c; C1, C2).

function fixtureArchive() {
  const root = tempRoot();
  const lock = ArchiveLock.tryAcquire(root)!;
  const ledger = new Ledger(ledgerPath(root));
  const now = new Date("2026-11-05T12:00:00Z");

  // 1: discovery only (no audio yet).
  const a = initInput(1, now, "2026-11-01T09:00:00Z");
  initializeRecording(root, a);
  // 2: a failed download.
  const b = initInput(2, now, "2026-10-30T09:00:00Z");
  let mb = initializeRecording(root, b);
  mb = { ...mb, states: { ...mb.states, audio: nextAudio(mb.states.audio, { kind: "download_failed", errorClass: "http_500" }, now, 0.5) } };
  commitManifest(absDir(root, b.rel), mb);
  // 3: transcript present, the rest pending — a second revision.
  const c = initInput(3, now, "2026-09-15T09:00:00Z");
  let mc = initializeRecording(root, c);
  const e = writeRevision(absDir(root, c.rel), { "meta.json": "{}", "plaud/transcript.json": "[1]" }, now);
  const arts = applyTextCheck(mc.states.artifacts, { pastDeadline: false, observed: { transcript: true }, presentRev: e.rev }, now);
  mc = withRevision({ ...mc, states: { ...mc.states, artifacts: arts, textBundle: deriveBundle(arts) } }, e, 3);
  commitManifest(absDir(root, c.rel), mc);

  return { root, lock, ledger, now, rels: [a.rel, b.rel, c.rel], ids: [a.facts.id, b.facts.id, c.facts.id] };
}

test("drop the db, rebuild from manifests: the derived tables are identical", () => {
  const { root, lock, ledger, now } = fixtureArchive();
  sweepArchive(root, ledger, lock, { now });
  ledger.db.prepare("INSERT INTO runs (id, kind, started_at) VALUES ('r1','pull','x')").run();
  const before = ledger.dumpDerived();
  assert.equal(ledger.count(), 3);
  ledger.close();

  for (const suffix of ["", "-wal", "-shm"]) rmSync(ledgerPath(root) + suffix, { force: true });
  const fresh = new Ledger(ledgerPath(root));
  rebuildIndex(root, fresh, lock, now);
  assert.equal(fresh.dumpDerived(), before);
  // Observational history is NOT reproduced, by design.
  assert.equal((fresh.db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number }).n, 0);
  fresh.close();
  lock.release();
});

test("rebuild after discovery-only keeps the id; after a failed download keeps audio_failed", () => {
  const { root, lock, ledger, now, ids } = fixtureArchive();
  rebuildIndex(root, ledger, lock, now);
  assert.equal(ledger.get(ids[0]!)?.audio_state, "audio_pending");
  const failed = ledger.get(ids[1]!);
  assert.equal(failed?.audio_state, "audio_failed");
  assert.equal(failed?.audio_attempts, 1);
  assert.equal(failed?.audio_last_error, "http_500");
  assert.ok(failed?.audio_next_retry_at);
  assert.equal(ledger.artifacts(ids[2]!).transcript, "present");
  assert.equal(ledger.artifacts(ids[2]!).note, "pending");
  assert.equal(ledger.get(ids[2]!)?.text_bundle_state, "plaud_text_pending");
  ledger.close();
  lock.release();
});

test("a corrupt recording is excluded from the index and reported", () => {
  const { root, lock, ledger, now, rels, ids } = fixtureArchive();
  sweepArchive(root, ledger, lock, { now });
  writeFileSync(join(absDir(root, rels[0]!), "rev-0001", "meta.json"), "tampered");
  const r = rebuildIndex(root, ledger, lock, now);
  assert.deepEqual(r.corrupt, [rels[0]]);
  assert.equal(ledger.get(ids[0]!), undefined);
  assert.equal(ledger.count(), 2);
  ledger.close();
  lock.release();
});

test("the sweep makes the manifest win over a stale ledger row (R2-3)", () => {
  const { root, lock, ledger, now, rels, ids } = fixtureArchive();
  sweepArchive(root, ledger, lock, { now });
  // Manifest moves on without the ledger being told (crash after manifest commit).
  const dir = absDir(root, rels[1]!);
  const r = readRecording(dir);
  assert.ok(r.status === "ok");
  if (r.status !== "ok") return;
  commitManifest(dir, { ...r.manifest, lastSeenAt: "2026-11-06T00:00:00.000Z" });
  assert.notEqual(ledger.get(ids[1]!)?.last_seen_at, "2026-11-06T00:00:00.000Z");
  const s = sweepArchive(root, ledger, lock, { now });
  assert.equal(s.rederived, 1, "only the changed manifest is re-derived");
  assert.equal(ledger.get(ids[1]!)?.last_seen_at, "2026-11-06T00:00:00.000Z");
  ledger.close();
  lock.release();
});

test("sweep completes an interrupted init and removes an empty one, outside any window (R3-2)", () => {
  const { root, lock, ledger, now } = fixtureArchive();
  // Empty dir: crash right after mkdir.
  const emptyRel = "2025/01/of_fakeempty";
  mkdirSync(absDir(root, emptyRel), { recursive: true });
  // meta.json committed, manifest not: crash before the manifest rename.
  const half = initInput(9, now, "2024-02-02T00:00:00Z");
  initializeRecording(root, half);
  rmSync(join(absDir(root, half.rel), MANIFEST));
  const s = sweepArchive(root, ledger, lock, { now });
  assert.equal(s.removed, 1);
  assert.equal(s.completed, 1);
  assert.equal(ledger.get(half.facts.id)?.audio_state, "audio_pending");
  ledger.close();
  lock.release();
});

test("sync lag samples are derived from first_seen_at − start_at", () => {
  const { root, lock, ledger, now, ids } = fixtureArchive();
  sweepArchive(root, ledger, lock, { now });
  const row = ledger.db.prepare("SELECT lag_hours FROM sync_lag_samples WHERE id=?").get(ids[0]!) as { lag_hours: number };
  // start 2026-11-01T09:00Z, first seen 2026-11-05T12:00Z = 99 h
  assert.equal(row.lag_hours, 99);
  ledger.close();
  lock.release();
});
