import { config, isAllowedHost, requirePipelineConfig } from "./config.js";
import { g3bFinish, g3bStart } from "./gate/g3b.js";
import { openMcpSource } from "./pipelineRuntime.js";

/**
 * plaudport gate g3b start | finish — the live expired-URL check (P0 gate G3b).
 * Prints dates, counts and PASS/FAIL only; paste the output into docs/P0-GATE.md.
 */

const [check, step, ...rest] = process.argv.slice(2);
if (check !== "g3b" || (step !== "start" && step !== "finish") || rest.length) {
  console.error("Usage: plaudport gate g3b start   (keep one real audio URL)\n       plaudport gate g3b finish  (24 h later: expired URL refused, refreshed one downloads)");
  process.exit(1);
}
const cfg = requirePipelineConfig();
try {
  const src = await openMcpSource(cfg, config.requestTimeoutMs);
  try {
    if (step === "start") {
      const r = await g3bStart(cfg.archiveRoot, src);
      console.log(`G3b started: kept one audio URL issued ${r.issuedAt}.\nRun \`plaudport gate g3b finish\` after ${r.finishAfter}.`);
    } else {
      const r = await g3bFinish(cfg.archiveRoot, src, { isAllowedHost });
      console.log(
        [
          `G3b ${r.pass ? "PASS" : "FAIL"}`,
          `  kept URL age: ${r.ageHours.toFixed(1)} h`,
          `  expired URL refused by storage: ${r.staleRefused ? "yes" : "no"} (HTTP ${r.staleStatus ?? "none — it still worked"})`,
          `  refreshed URL downloaded: ${r.refreshedDownloaded ? "yes" : "no"}`,
          `  sha256 matches the archived audio: ${r.hashMatchesArchive ? "yes" : "no"}`,
        ].join("\n"),
      );
      process.exitCode = r.pass ? 0 : 1;
    }
  } finally {
    await src.close();
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
