import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { absDir, lockInfoPath } from "./layout.js";
import { ArchiveLock, probeLock } from "./lock.js";
import { initializeRecording, readRecording } from "./revision.js";
import { initInput, tempRoot } from "../testing/fixtures.js";

// P0-PLAN T2a (FR14b; C3, R2-1, R3-1). Real child processes: the lock is the
// kernel's, so only separate processes can prove it.

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "lockChild.ts");

function child(args: string[]): { proc: ChildProcess; line: Promise<string>; exit: Promise<number | null> } {
  const proc = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  const line = new Promise<string>((resolve) => {
    let buf = "";
    proc.stdout!.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) resolve(buf.slice(0, i));
    });
    proc.on("exit", () => resolve(buf.trim()));
  });
  const exit = new Promise<number | null>((resolve) => proc.on("exit", (c) => resolve(c)));
  return { proc, line, exit };
}

test("a second acquirer is refused while the holder lives, including while it is SIGSTOPped", async () => {
  const root = tempRoot();
  const holder = child(["hold", root]);
  assert.equal(await holder.line, "HELD");

  assert.equal(ArchiveLock.tryAcquire(root), null, "refused while the holder runs");
  const contender = child(["hold", root]);
  assert.equal(await contender.line, "BUSY");
  assert.equal(await contender.exit, 3);

  holder.proc.kill("SIGSTOP");
  try {
    assert.equal(ArchiveLock.tryAcquire(root), null, "a suspended holder keeps the lock (R3-1)");
    assert.equal(probeLock(root).held, true);
  } finally {
    holder.proc.kill("SIGCONT");
  }
  assert.equal(ArchiveLock.tryAcquire(root), null, "still held after resume");

  holder.proc.kill("SIGKILL");
  await holder.exit;
  const mine = ArchiveLock.tryAcquire(root);
  assert.ok(mine, "the OS released the lock when the holder was killed");
  mine.release();
});

test("a leftover lock file alone does not block acquisition", () => {
  const root = tempRoot();
  const first = ArchiveLock.tryAcquire(root);
  assert.ok(first);
  first.release();
  writeFileSync(lockInfoPath(root), JSON.stringify({ pid: 999999, host: "elsewhere", startedAt: "2020-01-01T00:00:00Z" }));
  assert.ok(existsSync(lockInfoPath(root)));
  const probe = probeLock(root);
  assert.equal(probe.held, false);
  assert.equal(probe.leftoverFile, true);
  const again = ArchiveLock.tryAcquire(root);
  assert.ok(again, "a stale file is informational only");
  again.release();
});

test("the same process cannot take the lock twice", () => {
  const root = tempRoot();
  const a = ArchiveLock.tryAcquire(root);
  assert.ok(a);
  assert.equal(ArchiveLock.tryAcquire(root), null);
  a.release();
  const b = ArchiveLock.tryAcquire(root);
  assert.ok(b);
  b.release();
});

test("two interleaved writers serialize: no duplicate revision, no lost commit", async () => {
  const root = tempRoot();
  const input = initInput(1);
  const lock = ArchiveLock.tryAcquire(root)!;
  initializeRecording(root, input);
  lock.release();

  const N = 6;
  const a = child(["write", root, input.rel, String(N)]);
  const b = child(["write", root, input.rel, String(N)]);
  assert.equal(await a.exit, 0);
  assert.equal(await b.exit, 0);

  const dir = absDir(root, input.rel);
  const r = readRecording(dir);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  // 1 initial + 2N writes, numbered contiguously: no collision ever happened.
  assert.equal(r.manifest.current.rev, `rev-${String(1 + 2 * N).padStart(4, "0")}`);
  assert.equal(r.fellBack, false);
  const revs = readdirSync(dir).filter((n) => n.startsWith("rev-"));
  assert.ok(revs.every((n) => !n.endsWith(".tmp")), "no abandoned temp revisions");
  for (const h of r.manifest.history) assert.ok(revs.includes(h.rev), "history revisions were not cleaned up by the other writer");
});
