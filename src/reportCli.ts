import { config, requirePipelineConfig } from "./config.js";
import { buildReport, renderReport } from "./report.js";

/** plaudport report [--lag] [--verify-audio N] [--json] */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let lag = false;
  let json = false;
  let verifyAudio = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lag") lag = true;
    else if (a === "--json") json = true;
    else if (a === "--verify-audio") {
      verifyAudio = Number(argv[++i]);
      if (!Number.isInteger(verifyAudio) || verifyAudio < 1) {
        console.error("--verify-audio needs a sample size, e.g. 20");
        process.exit(1);
      }
    } else {
      console.error("Usage: plaudport report [--lag] [--verify-audio N] [--json]");
      process.exit(a === "-h" || a === "--help" ? 0 : 1);
    }
  }
  const cfg = requirePipelineConfig();
  const r = await buildReport(cfg.archiveRoot, {
    lag,
    verifyAudio,
    revealIds: !config.redactSamples,
    retryReportAfter: cfg.retryReportAfter,
    overlapDays: cfg.overlapDays,
    textTimeoutDays: cfg.textTimeoutDays,
  });
  if (!r) {
    console.log("No archive yet — run `plaudport pull --all` (or --since) first.");
    return;
  }
  console.log(json ? JSON.stringify(r, null, 2) : renderReport(r));
  if (r.audioVerify && (r.audioVerify.mismatched || r.audioVerify.missing)) process.exit(1);
}

main().catch((e) => {
  console.error(`report failed: ${(e as Error).name}`);
  process.exit(1);
});
