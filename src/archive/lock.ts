import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { lockDbPath, lockInfoPath, STATE_DIR } from "./layout.js";

/**
 * The single-writer archive lock (P0-D8; PRD FR14b).
 *
 * An OS-held exclusive advisory lock: we hold `BEGIN EXCLUSIVE` on a dedicated
 * `.plaudport/lock.sqlite` for the whole run. SQLite takes that with POSIX
 * `fcntl` locks, which the KERNEL keeps while the process is merely suspended
 * and releases on exit (clean, crash or kill). So there is never a moment when
 * two processes both hold it, and nothing in user space decides liveness — no
 * lease, no age, no takeover.
 *
 * Acquire is non-blocking: a contender gets `null` (the CLI exits 3, "archive
 * busy"). The `.plaudport/lock` JSON file is informational only (pid, host,
 * start time, for doctor/report) and is never used to infer staleness; a
 * leftover one after a crash is harmless.
 *
 * POSIX-lock footgun: closing ANY fd on a file drops every lock the process
 * holds on it. SQLite guards its own connections against this; we additionally
 * never open lock.sqlite outside this module.
 */

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Strong references to every held lock. Without this, a caller that drops its
 * ArchiveLock reference lets the GC finalize the better-sqlite3 connection,
 * which closes the fd and makes the OS release the lock while the process still
 * believes it holds it (reproduced; found by the Codex re-review of 51db58e).
 * A lock now lives until release() or process exit, whatever the caller keeps.
 */
const HELD = new Set<ArchiveLock>();

export class ArchiveLock {
  private constructor(
    private db: Database.Database | null,
    readonly root: string,
    readonly info: LockInfo,
  ) {}

  /** Try once; `null` if another live process holds the lock. */
  static tryAcquire(root: string, now: Date = new Date()): ArchiveLock | null {
    mkdirSync(join(root, STATE_DIR), { recursive: true, mode: 0o700 });
    let db: Database.Database | null = null;
    try {
      db = new Database(lockDbPath(root), { timeout: 0 });
      db.exec("BEGIN EXCLUSIVE");
    } catch (e) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      if (isBusy(e)) return null;
      throw e;
    }
    const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: now.toISOString() };
    try {
      writeFileSync(lockInfoPath(root), JSON.stringify(info) + "\n", { mode: 0o600 });
    } catch {
      /* informational only */
    }
    const lock = new ArchiveLock(db, root, info);
    HELD.add(lock);
    return lock;
  }

  get held(): boolean {
    return this.db !== null;
  }

  /** Throws unless still held — a guard for write paths, not a liveness check. */
  assertHeld(): void {
    if (!this.db) throw new Error("archive lock is not held");
  }

  release(): void {
    if (!this.db) return;
    try {
      this.db.exec("ROLLBACK");
    } finally {
      this.db.close();
      this.db = null;
      HELD.delete(this);
    }
  }
}

function isBusy(e: unknown): boolean {
  const code = (e as { code?: string }).code ?? "";
  // Extended codes too (SQLITE_BUSY_RECOVERY, SQLITE_LOCKED_SHAREDCACHE, …).
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED") || /database is (locked|busy)/i.test(String(e));
}

/**
 * For `doctor`/`report`: is the lock held by a live process right now? Probes
 * with a non-blocking BEGIN EXCLUSIVE and immediately rolls back. Never breaks
 * a held lock. Must not be called by the process that holds it.
 */
export function probeLock(root: string): { held: boolean; info: LockInfo | null; leftoverFile: boolean } {
  const infoPath = lockInfoPath(root);
  let info: LockInfo | null = null;
  if (existsSync(infoPath)) {
    try {
      info = JSON.parse(readFileSync(infoPath, "utf8")) as LockInfo;
    } catch {
      info = null;
    }
  }
  if (!existsSync(lockDbPath(root))) return { held: false, info, leftoverFile: existsSync(infoPath) };
  const db = new Database(lockDbPath(root), { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
    return { held: false, info, leftoverFile: existsSync(infoPath) };
  } catch (e) {
    if (isBusy(e)) return { held: true, info, leftoverFile: false };
    throw e;
  } finally {
    db.close();
  }
}
