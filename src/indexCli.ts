import { requirePipelineConfig } from "./config.js";
import { ledgerPath } from "./archive/layout.js";
import { ArchiveLock } from "./archive/lock.js";
import { Ledger } from "./ledger/db.js";
import { rebuildIndex } from "./ledger/sweep.js";

/**
 * plaudport index rebuild — recreate the ledger's derived tables from the
 * archive's manifests alone (FR14c), under the archive lock. Run history
 * (`runs`, `defects`) is observational and is kept, not reproduced.
 */

const [sub, ...rest] = process.argv.slice(2);
if (sub !== "rebuild" || rest.length) {
  console.error("Usage: plaudport index rebuild");
  process.exit(1);
}
const cfg = requirePipelineConfig();
const lock = ArchiveLock.tryAcquire(cfg.archiveRoot);
if (!lock) {
  console.error("archive busy: another PlaudPort process holds the archive lock");
  process.exit(3);
}
const ledger = new Ledger(ledgerPath(cfg.archiveRoot));
try {
  const r = rebuildIndex(cfg.archiveRoot, ledger, lock);
  console.log(
    `index rebuilt from ${r.scanned} recording dir(s): ${ledger.count()} indexed` +
      (r.completed ? `, ${r.completed} interrupted init(s) completed` : "") +
      (r.removed ? `, ${r.removed} empty dir(s) removed` : "") +
      (r.corrupt.length ? `, ${r.corrupt.length} CORRUPT (excluded)` : "") +
      (r.fellBack.length ? `, ${r.fellBack.length} on a previous revision (manifest-mismatch)` : ""),
  );
  if (r.corrupt.length) process.exitCode = 1;
} finally {
  ledger.close();
  lock.release();
}
