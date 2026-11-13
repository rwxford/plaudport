import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { absDir, MANIFEST } from "../archive/layout.js";
import type { ArchiveLock } from "../archive/lock.js";
import { cleanupRecording, commitManifest, completeInterruptedInit, listRecordingDirs, readRecording, sha256 } from "../archive/revision.js";
import { reconcileManifestWithRevision } from "../pull/states.js";
import type { Ledger } from "./db.js";

/**
 * Startup reconcile (P0-PLAN §7 step 0b; R2-3, R3-2) and `index rebuild`
 * (FR14c). Walks EVERY recording dir — not just this run's window — and makes
 * the ledger agree with the archive, the manifest being the authority:
 *
 *   manifest present, unchanged hash   → nothing (fast path)
 *   manifest present, new/absent row   → verify, re-derive the row
 *   no committed manifest              → interrupted init: complete or remove
 *   corrupt                            → excluded from the index and reported
 */

export interface SweepResult {
  scanned: number;
  rederived: number;
  completed: number;
  removed: number;
  corrupt: string[]; // relative dirs — never logged unredacted
  fellBack: string[];
  cleaned: number;
}

export function sweepArchive(
  root: string,
  ledger: Ledger,
  lock: ArchiveLock,
  opts: { force?: boolean; now?: Date } = {},
): SweepResult {
  lock.assertHeld();
  const now = opts.now ?? new Date();
  const res: SweepResult = { scanned: 0, rederived: 0, completed: 0, removed: 0, corrupt: [], fellBack: [], cleaned: 0 };
  const seen = new Set<string>();
  for (const rel of listRecordingDirs(root)) {
    res.scanned++;
    const dir = absDir(root, rel);
    const mp = join(dir, MANIFEST);
    if (!existsSync(mp)) {
      const r = completeInterruptedInit(dir);
      if (r.kind === "removed") {
        res.removed++;
        continue;
      }
      res.completed++;
    }
    const hash = sha256(readFileSync(mp));
    const row = ledger.byDir(rel);
    if (!opts.force && row && row.manifest_hash === hash) {
      seen.add(row.id);
      continue;
    }
    const r = readRecording(dir);
    if (r.status !== "ok") {
      res.corrupt.push(rel);
      if (row) ledger.remove(row.id);
      continue;
    }
    let m = r.manifest;
    let h = hash;
    if (r.fellBack) {
      res.fellBack.push(rel);
      // Artifacts only the unverifiable revision held are reopened, so the
      // next text check fetches them again (they are not silently dropped).
      const fixed = reconcileManifestWithRevision(m, r.rev, now);
      if (fixed) {
        commitManifest(dir, fixed);
        m = fixed;
        h = sha256(readFileSync(mp));
      }
    }
    ledger.upsertFromManifest(m, h);
    seen.add(m.id);
    res.rederived++;
    res.cleaned += cleanupRecording(dir, m, now).length;
  }
  // A ledger row whose recording dir vanished is not derived from anything.
  for (const id of ledger.allIds()) if (!seen.has(id)) ledger.remove(id);
  return res;
}

/** `plaudport index rebuild`: recreate the derived tables from manifests alone. */
export function rebuildIndex(root: string, ledger: Ledger, lock: ArchiveLock, now?: Date): SweepResult {
  ledger.clearDerived();
  return sweepArchive(root, ledger, lock, { force: true, now });
}
