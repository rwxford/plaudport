import { config, isAllowedHost, requirePipelineConfig } from "./config.js";
import { openMcpSource, SetupError } from "./pipelineRuntime.js";
import { EXIT, runPull, type PullOptions } from "./pull/pull.js";

/**
 * plaudport pull [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all] [--reconcile]
 *                [--dry-run] [--recheck-text <id>… | --recheck-text --all]
 *
 * Exit codes: 0 ok · 1 error · 2 discovery defects found (--reconcile) ·
 * 3 archive busy (another run holds the lock) · 4 Plaud login needed.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parsePullArgs(argv: string[]): PullOptions {
  const o: PullOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (!v || !DATE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`${a} needs a date like 2026-10-15`);
      return v;
    };
    if (a === "--since") o.since = val();
    else if (a === "--until") o.until = val();
    else if (a === "--all") {
      if (o.recheckText !== undefined && Array.isArray(o.recheckText) && o.recheckText.length === 0) o.recheckText = "all";
      else o.all = true;
    } else if (a === "--reconcile") o.reconcile = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--recheck-text") {
      const ids: string[] = [];
      while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) ids.push(argv[++i]!);
      o.recheckText = ids;
    } else if (a === "-h" || a === "--help") throw new Error("help");
    else throw new Error(`unknown option ${a}`);
  }
  if (Array.isArray(o.recheckText) && o.recheckText.length === 0) throw new Error("--recheck-text needs recording ids, or --all");
  if (o.since && o.until && o.until < o.since) throw new Error("--until is before --since");
  return o;
}

const USAGE = `Usage: plaudport pull [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all] [--reconcile] [--dry-run]
                      [--recheck-text <id>… | --recheck-text --all]

A bare \`pull\` reaches back PLAUDPORT_PULL_OVERLAP_DAYS (default 14) from the newest
recording already archived. The FIRST archive needs --all (or --since) to backfill.`;

async function main(): Promise<void> {
  let opts: PullOptions;
  try {
    opts = parsePullArgs(process.argv.slice(2));
  } catch (e) {
    if ((e as Error).message !== "help") console.error((e as Error).message + "\n");
    console.error(USAGE);
    process.exit((e as Error).message === "help" ? 0 : 1);
  }
  const cfg = requirePipelineConfig();
  try {
    const { exitCode } = await runPull(opts, {
      cfg,
      openSource: () => openMcpSource(cfg, config.requestTimeoutMs),
      isAllowedHost,
      revealIds: !config.redactSamples,
    });
    process.exit(exitCode);
  } catch (e) {
    if (e instanceof SetupError) {
      console.error(e.message);
      process.exit(EXIT.error);
    }
    throw e;
  }
}

if (process.argv[1] && /[/\\]pullCli\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`pull failed: ${(e as Error).name}`);
    process.exit(EXIT.error);
  });
}
