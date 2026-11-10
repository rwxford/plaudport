/**
 * Child-process helper for lock.test.ts: the lock is an OS lock, so it has to be
 * exercised across real processes, not simulated in one.
 *
 *   hold  <root>                  acquire once; print HELD (or BUSY, exit 3); wait to be killed
 *   write <root> <rel> <count>    spin until acquired; write <count> revisions + manifests; release
 */
import { ArchiveLock } from "../archive/lock.js";
import { absDir } from "../archive/layout.js";
import { cleanupRecording, commitManifest, readRecording, withRevision, writeRevision } from "../archive/revision.js";

const [mode, root, rel, countArg] = process.argv.slice(2);

if (mode === "hold") {
  const lock = ArchiveLock.tryAcquire(root!);
  if (!lock) {
    process.stdout.write("BUSY\n");
    process.exit(3);
  }
  process.stdout.write("HELD\n");
  setInterval(() => {}, 1 << 30);
} else if (mode === "write") {
  const count = Number(countArg);
  let lock: ArchiveLock | null = null;
  while (!(lock = ArchiveLock.tryAcquire(root!))) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const dir = absDir(root!, rel!);
  for (let i = 0; i < count; i++) {
    const r = readRecording(dir);
    if (r.status !== "ok") throw new Error("expected a readable recording");
    const now = new Date();
    const entry = writeRevision(dir, { "meta.json": `{"writer":${process.pid},"i":${i}}` }, now);
    const m = withRevision(r.manifest, entry, 3);
    commitManifest(dir, m);
    cleanupRecording(dir, m, now);
  }
  lock.release();
  process.stdout.write("DONE\n");
} else {
  process.exit(2);
}
