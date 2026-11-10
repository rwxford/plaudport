import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePipelineSettings, type PipelineConfig } from "../config.js";
import { SimulatedCrash, setFsHook } from "../archive/fsx.js";
import { absDir, ledgerPath } from "../archive/layout.js";
import { ArchiveLock } from "../archive/lock.js";
import { readRecording } from "../archive/revision.js";
import { Ledger } from "../ledger/db.js";
import { FakePlaud, fakeRecording, fullArtifacts, type FakeFixture } from "../testing/fakePlaud.js";
import { tempRoot } from "../testing/fixtures.js";
import { computeWindow, EXIT, runPull, type PullOptions } from "./pull.js";

// P0-PLAN T7 + T8 (FR1, FR1a–d, FR3; C1, C2, C6, R2-2, R2-3, R3-2) on the fake server.

const DAY = 86_400_000;
const T = new Date("2026-11-05T12:00:00Z");

function harness(fixture: FakeFixture, cfgOver: Partial<PipelineConfig> = {}) {
  const fake = new FakePlaud(fixture);
  const root = tempRoot("archive");
  const parsed = parsePipelineSettings({ PLAUDPORT_ARCHIVE_ROOT: root });
  assert.ok(parsed.ok);
  const cfg = { ...(parsed.ok ? parsed.config : ({} as PipelineConfig)), ...cfgOver };
  const lines: string[] = [];
  const pull = (opts: PullOptions = {}, now: Date = T) =>
    runPull(opts, {
      cfg,
      openSource: () => fake.open(),
      isAllowedHost: (h) => h.startsWith("127.0.0.1"),
      now: () => now,
      rand: () => 0.5,
      log: (l) => lines.push(l),
    });
  const ledger = () => new Ledger(ledgerPath(root), { readonly: true });
  const row = (id: string) => {
    const l = ledger();
    try {
      return { row: l.get(id), arts: l.artifacts(id) };
    } finally {
      l.close();
    }
  };
  const manifest = (id: string) => {
    const r = row(id).row!;
    const rr = readRecording(absDir(root, r.dir));
    assert.equal(rr.status, "ok");
    return { dir: absDir(root, r.dir), ...(rr as Extract<typeof rr, { status: "ok" }>) };
  };
  return { fake, root, cfg, pull, row, manifest, lines };
}

function fakeAudioSha(id: string): string {
  const chunks = [Buffer.from("ID3")];
  let h = Buffer.from(id);
  for (let i = 0; i < 64; i++) chunks.push((h = createHash("sha256").update(h).digest()));
  return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}

test("window: overlap from the newest known recording, --since/--until, --all", () => {
  assert.deepEqual(computeWindow({}, null, 14, T), { from: "2026-10-22", to: "2026-11-06" });
  assert.deepEqual(computeWindow({}, "2026-11-01T10:00:00.000Z", 14, T), { from: "2026-10-17", to: "2026-11-06" });
  assert.deepEqual(computeWindow({ since: "2026-10-15", until: "2026-10-15" }, null, 14, T), { from: "2026-10-15", to: "2026-10-15" });
  assert.deepEqual(computeWindow({ all: true }, "2026-11-01T10:00:00.000Z", 14, T), { from: "1970-01-01", to: "2026-11-06" });
  assert.equal(computeWindow({ reconcile: true }, null, 14, T).from, "1970-01-01");
});

test("first pull archives audio (sha256 verified) and every Plaud artifact; empty highlights resolve absent", async () => {
  const recs = [1, 2, 3].map((n) => fakeRecording(n, `2026-11-0${n}T09:00:00`));
  recs[2]!.artifacts = { ...fullArtifacts(), highlights: { items: [{ time: 12000 }] } }; // FR3: a pressed button
  const h = harness({ recordings: recs });
  const { exitCode, report } = await h.pull({ since: "2026-11-01" });
  assert.equal(exitCode, EXIT.ok);
  assert.equal(report.newIds, 3);
  assert.equal(report.audio.ok, 3);
  for (const r of recs) {
    const { row, arts } = h.row(r.id);
    assert.equal(row?.audio_state, "audio_ok");
    assert.equal(row?.audio_sha256, fakeAudioSha(r.id));
    const m = h.manifest(r.id);
    assert.equal(createHash("sha256").update(readFileSync(join(m.dir, "audio.mp3"))).digest("hex"), row?.audio_sha256);
    assert.equal(row?.text_bundle_state, "plaud_text_ok");
    assert.equal(arts.transcript, "present");
    assert.equal(arts.note, "present");
    assert.ok(m.rev.artifacts["plaud/transcript.json"]);
  }
  assert.equal(h.row(recs[0]!.id).arts.highlights, "absent", "an empty highlights block is a legitimate absent");
  const hl = h.manifest(recs[2]!.id);
  assert.equal(h.row(recs[2]!.id).arts.highlights, "present");
  assert.deepEqual(JSON.parse(readFileSync(join(hl.dir, hl.rev.rev, "plaud", "highlights.json"), "utf8")), [{ time: 12000 }]);
  // Redaction: the run log carries counts, never ids or titles.
  assert.ok(h.lines.every((l) => !/of_fake|Synthetic/.test(l)));
  const reportFile = readdirSync(join(h.root, ".plaudport", "reports"))[0]!;
  assert.doesNotMatch(readFileSync(join(h.root, ".plaudport", "reports", reportFile), "utf8"), /of_fake|Synthetic/);
});

test("a late-synced recording is discovered by the overlap window (FR1a)", async () => {
  const early = fakeRecording(1, "2026-11-04T09:00:00");
  const late = fakeRecording(2, "2026-10-28T09:00:00", { visibleFromRun: 2, created_at: "2026-11-05T08:00:00" });
  const h = harness({ recordings: [early, late] });
  await h.pull({ since: "2026-11-01" });
  assert.equal(h.row(late.id).row, undefined);
  const { report } = await h.pull({}, new Date(T.getTime() + 3600_000)); // ordinary run, no --since
  assert.equal(report.newIds, 1);
  assert.equal(h.row(late.id).row?.audio_state, "audio_ok");
  const lag = h.row(late.id).row!;
  assert.ok(Date.parse(lag.first_seen_at) - Date.parse(lag.start_at) > 12 * 3600_000);
});

test("a failed download is retried by id on a later run (FR1c)", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00", { audioFailures: 1 });
  const h = harness({ recordings: [r] });
  await h.pull({ since: "2026-11-01" });
  assert.equal(h.row(r.id).row?.audio_state, "audio_failed");
  assert.equal(h.row(r.id).row?.audio_attempts, 1);
  assert.equal(h.row(r.id).row?.audio_last_error, "http_500");
  // Not due yet: skipped.
  const early = await h.pull({}, new Date(T.getTime() + 60_000));
  assert.equal(early.report.audio.attempted, 0);
  const later = await h.pull({}, new Date(T.getTime() + DAY));
  assert.equal(later.report.audio.ok, 1);
  assert.equal(h.row(r.id).row?.audio_state, "audio_ok");
});

test("an expired presigned URL (S3 403) is re-fetched without counting an attempt (FR1c, G3a)", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00");
  const h = harness({ recordings: [r], expireFirstUrls: 1 });
  const { report } = await h.pull({ since: "2026-11-01" });
  assert.equal(report.audio.urlRefreshed, 1);
  assert.equal(h.row(r.id).row?.audio_state, "audio_ok");
  assert.equal(h.row(r.id).row?.audio_attempts, 0);
});

test("PLAUDPORT_DEBUG_URL_AGE_HOURS=25 forces the proactive refresh; attempts stay 0 (G3a)", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00");
  const h = harness({ recordings: [r] }, { debugUrlAgeHours: 25 });
  const { report } = await h.pull({ since: "2026-11-01" });
  assert.equal(report.audio.urlRefreshed, 1);
  assert.equal(h.row(r.id).row?.audio_attempts, 0);
  assert.equal(h.row(r.id).row?.audio_state, "audio_ok");
});

for (const [label, crashOn, expectDirAfterCrash] of [
  ["after the dir is created (empty init)", (p: string, op: string) => op === "write" && p.endsWith("meta.json.tmp"), true],
  ["after meta.json, before the manifest", (p: string, op: string) => op === "write" && p.endsWith("manifest.json.tmp"), true],
] as const) {
  test(`a crash ${label} is recovered by an ORDINARY pull (R3-2)`, async () => {
    const r = fakeRecording(1, "2026-11-04T09:00:00");
    const h = harness({ recordings: [r] });
    let fired = false;
    setFsHook((op) => {
      if (!fired && crashOn(op.path, op.op)) {
        fired = true;
        throw new SimulatedCrash(op);
      }
    });
    try {
      const first = await h.pull({ since: "2026-11-01" });
      assert.equal(first.exitCode, EXIT.error);
    } finally {
      setFsHook(null);
    }
    assert.equal(existsSync(join(h.root, "2026", "11", r.id)), expectDirAfterCrash);
    const second = await h.pull({ since: "2026-11-01" });
    assert.equal(second.exitCode, EXIT.ok);
    assert.equal(h.row(r.id).row?.audio_state, "audio_ok");
    assert.deepEqual(readdirSync(join(h.root, "2026", "11")), [r.id], "no duplicate directory");
  });
}

test("a manifest committed but missing from the ledger is ADOPTED, never re-initialized (R2-3)", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00", { artifacts: { ...fullArtifacts(), note: { after: 1, items: [{ data_content: "n" }] } } });
  const h = harness({ recordings: [r] });
  await h.pull({ since: "2026-11-01" });
  const before = h.manifest(r.id);
  assert.equal(before.manifest.current.rev, "rev-0002");
  // Lose the ledger entirely (crash after manifest commit, before the UPSERT).
  const l = new Ledger(ledgerPath(h.root));
  l.remove(r.id);
  l.close();
  await h.pull({ since: "2026-11-01" }, new Date(T.getTime() + 3600_000));
  const after = h.manifest(r.id);
  assert.equal(after.manifest.firstSeenAt, before.manifest.firstSeenAt, "not re-initialized");
  assert.equal(after.manifest.current.rev, "rev-0003", "the later note revision was added on top, nothing overwritten");
  assert.ok(after.manifest.history.some((e) => e.rev === "rev-0002"));
});

test("staggered artifacts are each collected, each adding a revision (C2)", async () => {
  const a = fakeRecording(1, "2026-11-04T09:00:00", {
    artifacts: { ...fullArtifacts(), transcript: { after: 0, items: [{ c: "t" }] }, note: { after: 1, items: [{ data_content: "n" }] }, polish: null, outline: null },
  });
  const b = fakeRecording(2, "2026-11-04T10:00:00", {
    artifacts: { ...fullArtifacts(), transcript: { after: 1, items: [{ c: "t" }] }, note: { after: 0, items: [{ data_content: "n" }] }, polish: null, outline: null },
  });
  const h = harness({ recordings: [a, b] });
  await h.pull({ since: "2026-11-01" });
  assert.equal(h.row(a.id).arts.transcript, "present");
  assert.equal(h.row(a.id).arts.note, "pending");
  assert.equal(h.row(b.id).arts.note, "present");
  assert.equal(h.row(b.id).arts.transcript, "pending");
  await h.pull({}, new Date(T.getTime() + 3600_000));
  for (const r of [a, b]) {
    const m = h.manifest(r.id);
    assert.equal(m.manifest.current.rev, "rev-0003");
    assert.ok(m.rev.artifacts["plaud/transcript.json"] && m.rev.artifacts["plaud/note.json"], "both carried in the latest revision");
    assert.equal(h.row(r.id).row?.text_bundle_state, "plaud_text_pending", "polish/outline still pending until age-out");
  }
});

test("a bundle first revisited AFTER its deadline resolves absent without fetching (R2-2)", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00", {
    artifacts: { ...fullArtifacts(), note: { after: 1000, items: [{ data_content: "n" }] } },
  });
  const h = harness({ recordings: [r] });
  await h.pull({ since: "2026-11-01" });
  assert.equal(h.row(r.id).arts.note, "pending");
  const checksBefore = h.fake.state().checks[`${r.id}:note`];
  await h.pull({}, new Date(T.getTime() + 8 * DAY));
  assert.equal(h.fake.state().checks[`${r.id}:note`], checksBefore, "no fetch past the deadline");
  assert.equal(h.row(r.id).arts.note, "absent");
  assert.equal(h.row(r.id).arts.transcript, "present");
  assert.equal(h.row(r.id).row?.text_bundle_state, "plaud_text_ok");
});

test("a transcript-less recording lands plaud_text_pending and later resolves (G4 on the fake)", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00", {
    artifacts: { transcript: { after: 1, items: [{ c: "t" }] }, polish: { after: 1, items: [{ c: "p" }] }, outline: { after: 1, items: [{ o: 1 }] }, highlights: { after: 1, items: [] }, note: { after: 1, items: [{ data_content: "n" }] } },
  });
  const h = harness({ recordings: [r] });
  await h.pull({ since: "2026-11-01" });
  assert.equal(h.row(r.id).row?.text_bundle_state, "plaud_text_pending");
  await h.pull({}, new Date(T.getTime() + 600_000));
  assert.equal(h.row(r.id).row?.text_bundle_state, "plaud_text_ok");
});

test("--recheck-text reopens absent artifacts", async () => {
  const r = fakeRecording(1, "2026-11-04T09:00:00", { artifacts: { ...fullArtifacts(), outline: { after: 1, items: [{ o: 1 }] } } });
  const h = harness({ recordings: [r] }, { textTimeoutDays: 1 });
  await h.pull({ since: "2026-11-01" });
  await h.pull({}, new Date(T.getTime() + 2 * DAY));
  assert.equal(h.row(r.id).arts.outline, "absent");
  await h.pull({ recheckText: "all" }, new Date(T.getTime() + 2 * DAY + 60_000));
  assert.equal(h.row(r.id).arts.outline, "present");
});

test("--dry-run lists and counts but writes nothing; --until bounds the window to one day", async () => {
  const recs = [fakeRecording(1, "2026-10-14T09:00:00"), fakeRecording(2, "2026-10-15T09:00:00"), fakeRecording(3, "2026-10-15T20:00:00"), fakeRecording(4, "2026-10-16T09:00:00")];
  const h = harness({ recordings: recs });
  const { report, exitCode } = await h.pull({ since: "2026-10-15", until: "2026-10-15", dryRun: true });
  assert.equal(exitCode, EXIT.ok);
  assert.equal(report.listed, 2);
  assert.equal(report.newIds, 2);
  assert.equal(existsSync(join(h.root, ".plaudport")), false, "no lock, no ledger, no report");
  assert.deepEqual(readdirSync(h.root), []);
});

test("--reconcile: a recording outside every window is a logged defect (exit 2), then archived (FR1d)", async () => {
  const recent = fakeRecording(1, "2026-11-04T09:00:00");
  const old = fakeRecording(2, "2025-03-01T09:00:00", { visibleFromRun: 2 });
  const h = harness({ recordings: [recent, old] });
  await h.pull({ since: "2026-11-01" });
  const normal = await h.pull({}, new Date(T.getTime() + 3600_000));
  assert.equal(normal.report.newIds, 0, "an ordinary pull cannot see it");
  const rec = await h.pull({ reconcile: true }, new Date(T.getTime() + 7200_000));
  assert.equal(rec.exitCode, EXIT.defects);
  assert.equal(rec.report.defects, 1);
  assert.ok(h.lines.some((l) => /discovery defect/.test(l)));
  assert.equal(h.row(old.id).row?.audio_state, "audio_ok");
  const l = new Ledger(ledgerPath(h.root), { readonly: true });
  assert.equal((l.db.prepare("SELECT COUNT(*) n FROM defects").get() as { n: number }).n, 1);
  l.close();
  const again = await h.pull({ reconcile: true }, new Date(T.getTime() + 9000_000));
  assert.equal(again.exitCode, EXIT.ok);
  assert.equal(again.report.defects, 0);
});

test("archive busy → exit 3; auth failure → exit 4 with the login instruction", async () => {
  const h = harness({ recordings: [fakeRecording(1, "2026-11-04T09:00:00")] });
  const lock = ArchiveLock.tryAcquire(h.root)!;
  const busy = await h.pull({ since: "2026-11-01" });
  assert.equal(busy.exitCode, EXIT.busy);
  lock.release();

  h.fake.set({ auth: "logged_out", recordings: [] });
  const auth = await h.pull({ since: "2026-11-01" });
  assert.equal(auth.exitCode, EXIT.auth);
  assert.match(auth.report.note ?? "", /plaudport login/);
});

test("> 500 recordings: --all pages through everything", async () => {
  const h = harness({ generate: { count: 520, from: "2025-06-01", perDay: 4 } });
  const { report } = await h.pull({ all: true, dryRun: true });
  assert.equal(report.listed, 520);
  assert.equal(report.pages, 6);
});
