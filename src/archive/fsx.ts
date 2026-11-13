import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable filesystem primitives for the archive (PRD FR14b, P0-PLAN §6).
 *
 * Every operation that matters to crash safety goes through here and is
 * reported to an optional hook. Tests use the hook two ways:
 *   - as a spy, to assert the `fsync` ordering is actually *issued*;
 *   - as a crash injector, by throwing `SimulatedCrash` at the Nth operation,
 *     which leaves the disk exactly as a killed process would.
 * Production code never sets the hook.
 */

export type FsOpKind = "mkdir" | "write" | "fsyncFile" | "fsyncDir" | "rename" | "remove";
export interface FsOp {
  op: FsOpKind;
  path: string;
  to?: string;
}

export class SimulatedCrash extends Error {
  constructor(public readonly at: FsOp) {
    super(`simulated crash before ${at.op} ${at.path}`);
  }
}

let hook: ((op: FsOp) => void) | null = null;

/** Install (or clear, with null) the test hook. Called BEFORE each operation. */
export function setFsHook(h: ((op: FsOp) => void) | null): void {
  hook = h;
}

function emit(op: FsOp): void {
  if (hook) hook(op);
}

export function fsyncFile(path: string): void {
  emit({ op: "fsyncFile", path });
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * fsync a directory so a rename or create inside it survives power loss. Some
 * platforms refuse fsync on a directory fd (EINVAL/EISDIR/EPERM); there the
 * call is a best-effort no-op, which is the strongest guarantee available.
 */
export function fsyncDir(path: string): void {
  emit({ op: "fsyncDir", path });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw e;
  } finally {
    closeSync(fd);
  }
}

export function renameDurable(from: string, to: string): void {
  emit({ op: "rename", path: from, to });
  renameSync(from, to);
}

export function writeRaw(path: string, data: string | Buffer): void {
  emit({ op: "write", path });
  writeFileSync(path, data, { mode: 0o600 });
}

export function mkdirOne(path: string): void {
  emit({ op: "mkdir", path });
  mkdirSync(path, { mode: 0o700 });
}

/**
 * Write a file atomically within its directory: temp name → fsync → rename.
 * Does NOT fsync the directory; callers decide when the rename must be durable.
 */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp`;
  writeRaw(tmp, data);
  fsyncFile(tmp);
  renameDurable(tmp, path);
}

/**
 * Create `target` and any missing ancestors below `stopAt` (which must exist),
 * then fsync each newly-created directory's PARENT, deepest first, up through
 * the nearest pre-existing ancestor (R2-4). Returns the directories created.
 */
export function mkdirsDurable(target: string, stopAt: string): string[] {
  const missing: string[] = [];
  let cur = target;
  while (cur !== stopAt && cur !== dirname(cur)) {
    if (existsSync(cur)) break;
    missing.unshift(cur);
    cur = dirname(cur);
  }
  for (const d of missing) mkdirOne(d);
  // Make each new entry durable: fsync the new dir itself, then its parent
  // (which records the entry). Deepest first so the chain is complete upward.
  for (const d of [...missing].reverse()) {
    fsyncDir(d);
    fsyncDir(dirname(d));
  }
  return missing;
}

/** Remove a file or directory tree (reported to the hook like every mutation). */
export function removeTree(path: string): void {
  emit({ op: "remove", path });
  rmSync(path, { recursive: true, force: true });
}
