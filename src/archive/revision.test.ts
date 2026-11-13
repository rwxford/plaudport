import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SimulatedCrash, setFsHook, type FsOp } from "./fsx.js";
import { absDir, AUDIO, MANIFEST } from "./layout.js";
import {
  cleanupRecording,
  commitAudio,
  commitManifest,
  completeInterruptedInit,
  initializeRecording,
  readRecording,
  sha256,
  withRevision,
  writeRevision,
} from "./revision.js";
import { initInput, tempRoot } from "../testing/fixtures.js";

// P0-PLAN T2 (FR14b; C1, C4, R2-4, R3-2).

function spy(fn: () => void): FsOp[] {
  const ops: FsOp[] = [];
  setFsHook((op) => ops.push(op));
  try {
    fn();
  } finally {
    setFsHook(null);
  }
  return ops;
}

const idx = (ops: FsOp[], pred: (o: FsOp) => boolean, from = 0) => {
  const i = ops.findIndex((o, j) => j >= from && pred(o));
  assert.ok(i >= 0, "expected operation not issued");
  return i;
};
const lastIdx = (ops: FsOp[], pred: (o: FsOp) => boolean) => {
  for (let i = ops.length - 1; i >= 0; i--) if (pred(ops[i]!)) return i;
  assert.fail("expected operation not issued");
};

test("discovery write issues the full fsync ordering, incl. new parents up to an existing ancestor", () => {
  const root = tempRoot();
  const input = initInput(1);
  const rec = absDir(root, input.rel);
  const ops = spy(() => initializeRecording(root, input));

  // Newly-created <YYYY>, <MM>, <id> are each fsynced, and so is each parent up to root.
  for (const d of [join(root, "2026"), join(root, "2026", "11"), rec]) {
    assert.ok(ops.some((o) => o.op === "mkdir" && o.path === d), `created ${d}`);
    assert.ok(ops.some((o) => o.op === "fsyncDir" && o.path === d), `fsynced ${d}`);
  }
  assert.ok(ops.some((o) => o.op === "fsyncDir" && o.path === root), "the pre-existing ancestor is fsynced");

  const metaTmp = join(rec, "rev-0001.tmp", "meta.json.tmp");
  const fsMeta = idx(ops, (o) => o.op === "fsyncFile" && o.path === metaTmp);
  const rnMeta = idx(ops, (o) => o.op === "rename" && o.path === metaTmp);
  const fsRev = idx(ops, (o) => o.op === "fsyncDir" && o.path === join(rec, "rev-0001.tmp"));
  const rnRev = idx(ops, (o) => o.op === "rename" && o.path === join(rec, "rev-0001.tmp"));
  const fsRecAfterRev = idx(ops, (o) => o.op === "fsyncDir" && o.path === rec, rnRev);
  const wMan = idx(ops, (o) => o.op === "write" && o.path === join(rec, "manifest.json.tmp"));
  const fsMan = idx(ops, (o) => o.op === "fsyncFile" && o.path === join(rec, "manifest.json.tmp"));
  const rnMan = idx(ops, (o) => o.op === "rename" && o.path === join(rec, "manifest.json.tmp"));
  const fsRecAfterMan = lastIdx(ops, (o) => o.op === "fsyncDir" && o.path === rec);
  assert.ok(fsMeta < rnMeta && rnMeta < fsRev && fsRev < rnRev && rnRev < fsRecAfterRev && fsRecAfterRev < wMan);
  assert.ok(wMan < fsMan && fsMan < rnMan && rnMan < fsRecAfterMan, "recording dir fsynced after the manifest rename");
});

test("a revision with nested artifacts fsyncs each file, each nested dir, then the rev dir", () => {
  const root = tempRoot();
  const input = initInput(1);
  initializeRecording(root, input);
  const rec = absDir(root, input.rel);
  const ops = spy(() => writeRevision(rec, { "meta.json": "{}", "plaud/note.json": "[1]", "plaud/outline.json": "[2]" }, new Date()));
  const tmp = join(rec, "rev-0002.tmp");
  const lastFileSync = lastIdx(ops, (o) => o.op === "fsyncFile");
  const nested = idx(ops, (o) => o.op === "fsyncDir" && o.path === join(tmp, "plaud"));
  const revDir = idx(ops, (o) => o.op === "fsyncDir" && o.path === tmp);
  const rn = idx(ops, (o) => o.op === "rename" && o.path === tmp);
  const recSync = idx(ops, (o) => o.op === "fsyncDir" && o.path === rec, rn);
  assert.equal(ops.filter((o) => o.op === "fsyncFile").length, 3, "each file fsynced");
  assert.ok(lastFileSync < nested && nested < revDir && revDir < rn && rn < recSync);
});

test("audio is durable before the manifest that references it", () => {
  const root = tempRoot();
  const input = initInput(1);
  const m = initializeRecording(root, input);
  const rec = absDir(root, input.rel);
  const part = join(rec, `${AUDIO}.part`);
  writeFileSync(part, "fake-mp3");
  const ops = spy(() =>
    commitAudio(rec, part, { ...m, audio: { file: AUDIO, bytes: 8, sha256: sha256("fake-mp3"), fetchedAt: "x" } }),
  );
  const fsPart = idx(ops, (o) => o.op === "fsyncFile" && o.path === part);
  const rnPart = idx(ops, (o) => o.op === "rename" && o.path === part);
  const fsRec = idx(ops, (o) => o.op === "fsyncDir" && o.path === rec, rnPart);
  const wMan = idx(ops, (o) => o.op === "write" && o.path.endsWith("manifest.json.tmp"));
  assert.ok(fsPart < rnPart && rnPart < fsRec && fsRec < wMan);
});

test("crash at every step of discovery → interrupted init is completed or discarded, never corrupt", () => {
  const input = initInput(1);
  const total = spy(() => initializeRecording(tempRoot(), input)).length;
  for (let k = 0; k < total; k++) {
    const root = tempRoot();
    const rec = absDir(root, input.rel);
    let n = 0;
    setFsHook((op) => {
      if (n++ === k) throw new SimulatedCrash(op);
    });
    try {
      assert.throws(() => initializeRecording(root, input), SimulatedCrash);
    } finally {
      setFsHook(null);
    }
    if (!existsSync(rec)) continue; // crashed before the dir existed: nothing to recover
    const r = readRecording(rec);
    if (r.status === "ok") {
      assert.equal(r.manifest.id, input.facts.id, `k=${k}: committed manifest is valid`);
      continue;
    }
    assert.equal(r.status, "no-manifest", `k=${k}: a dir without a committed manifest is NOT corrupt`);
    const done = completeInterruptedInit(rec);
    if (done.kind === "completed") {
      const again = readRecording(rec);
      assert.equal(again.status, "ok", `k=${k}: completion yields a verified manifest`);
      if (again.status === "ok") assert.equal(again.manifest.states.audio.state, "audio_pending");
    } else {
      assert.equal(existsSync(rec), false, `k=${k}: an empty dir is removed`);
    }
  }
});

test("crash at every step of a revision write → reader sees the old or the new revision, never a mix", () => {
  const input = initInput(1);
  const mkBase = () => {
    const root = tempRoot();
    const m0 = initializeRecording(root, input);
    return { rec: absDir(root, input.rel), m0 };
  };
  const files = { "meta.json": '{"v":2}', "plaud/transcript.json": "[1,2,3]", "plaud/note.json": '["n"]' };
  const doWrite = (rec: string, m0: ReturnType<typeof initializeRecording>) => {
    const e = writeRevision(rec, files, new Date());
    commitManifest(rec, withRevision(m0, e, 3));
  };
  const probe = mkBase();
  const total = spy(() => doWrite(probe.rec, probe.m0)).length;
  for (let k = 0; k <= total; k++) {
    const { rec, m0 } = mkBase();
    let n = 0;
    setFsHook((op) => {
      if (n++ === k) throw new SimulatedCrash(op);
    });
    try {
      if (k < total) assert.throws(() => doWrite(rec, m0), SimulatedCrash);
      else doWrite(rec, m0);
    } finally {
      setFsHook(null);
    }
    const r = readRecording(rec);
    assert.equal(r.status, "ok", `k=${k}`);
    if (r.status !== "ok") continue;
    assert.ok(["rev-0001", "rev-0002"].includes(r.rev.rev), `k=${k}`);
    if (r.rev.rev === "rev-0002") assert.deepEqual(Object.keys(r.rev.artifacts).sort(), Object.keys(files).sort());
    // Cleanup after recovery removes only unreferenced revisions and stale temp debris.
    cleanupRecording(rec, r.manifest, new Date(Date.now() + 2 * 3600_000));
    assert.ok(readdirSync(rec).every((d) => !d.endsWith(".tmp")), `k=${k}: temp debris cleaned`);
    assert.equal(readRecording(rec).status, "ok");
  }
});

test("hash mismatch in current falls back to history; nothing verifying is reported corrupt", () => {
  const root = tempRoot();
  const input = initInput(1);
  const m0 = initializeRecording(root, input);
  const rec = absDir(root, input.rel);
  const e = writeRevision(rec, { "meta.json": '{"v":2}', "plaud/note.json": '["n"]' }, new Date());
  commitManifest(rec, withRevision(m0, e, 3));

  writeFileSync(join(rec, "rev-0002", "plaud", "note.json"), "tampered");
  const r = readRecording(rec);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.fellBack, true);
    assert.equal(r.rev.rev, "rev-0001");
  }
  writeFileSync(join(rec, "rev-0001", "meta.json"), "tampered");
  assert.deepEqual(readRecording(rec), { status: "corrupt", reason: "no-revision-verifies" });

  writeFileSync(join(rec, MANIFEST), "{not json");
  assert.equal(readRecording(rec).status, "corrupt");
});

test("missing artifact in current → fallback", () => {
  const root = tempRoot();
  const input = initInput(1);
  const m0 = initializeRecording(root, input);
  const rec = absDir(root, input.rel);
  const e = writeRevision(rec, { "meta.json": '{"v":2}' }, new Date());
  commitManifest(rec, withRevision(m0, e, 3));
  rmSync(join(rec, "rev-0002", "meta.json"));
  const r = readRecording(rec);
  assert.ok(r.status === "ok" && r.fellBack && r.rev.rev === "rev-0001");
});

test("history is trimmed in the same swap and cleanup keeps exactly current + history", () => {
  const root = tempRoot();
  const input = initInput(1);
  let m = initializeRecording(root, input);
  const rec = absDir(root, input.rel);
  for (let i = 2; i <= 7; i++) {
    const e = writeRevision(rec, { "meta.json": `{"v":${i}}` }, new Date());
    m = withRevision(m, e, 3);
    commitManifest(rec, m);
    cleanupRecording(rec, m, new Date());
  }
  assert.equal(m.current.rev, "rev-0007");
  assert.deepEqual(m.history.map((h) => h.rev), ["rev-0006", "rev-0005", "rev-0004"]);
  assert.deepEqual(readdirSync(rec).filter((d) => d.startsWith("rev-")).sort(), ["rev-0004", "rev-0005", "rev-0006", "rev-0007"]);
  const onDisk = JSON.parse(readFileSync(join(rec, MANIFEST), "utf8"));
  assert.equal(onDisk.history.length, 3);
});

test("property: random write/crash sequences never lose a verified committed revision", () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 40; trial++) {
    const root = tempRoot();
    const input = initInput(trial + 1);
    let committed = initializeRecording(root, input);
    const rec = absDir(root, input.rel);
    for (let step = 0; step < 6; step++) {
      const crashAt = rand() < 0.5 ? Math.floor(rand() * 14) : -1;
      let n = 0;
      setFsHook((op) => {
        if (n++ === crashAt) throw new SimulatedCrash(op);
      });
      let next: typeof committed | null = null;
      try {
        const e = writeRevision(rec, { "meta.json": `{"t":${trial},"s":${step}}`, "plaud/x.json": String(rand()) }, new Date());
        next = withRevision(committed, e, 3);
        commitManifest(rec, next);
        committed = next;
      } catch (e) {
        if (!(e instanceof SimulatedCrash)) throw e;
      } finally {
        setFsHook(null);
      }
      const r = readRecording(rec);
      assert.equal(r.status, "ok");
      if (r.status !== "ok") return;
      // Either the last committed revision, or the one whose manifest rename landed just before the crash.
      assert.ok(
        r.manifest.current.rev === committed.current.rev || (next && r.manifest.current.rev === next.current.rev),
        `trial ${trial} step ${step}`,
      );
      assert.equal(r.fellBack, false, "a verified committed revision is never lost");
      committed = r.manifest;
      cleanupRecording(rec, committed, new Date(Date.now() + 2 * 3600_000));
    }
  }
});
