import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One command instead of a dozen `npm run` scripts: `plaudport <command> …`.
 *
 * This is what a Homebrew install (and `npx`) exposes on PATH, so the tool can
 * be used from anywhere without being inside the project folder. Each command
 * maps to the same module the matching `npm run` script runs; the arguments
 * after the command are passed straight through.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** command → the module (under src/) whose top level runs it. */
export const COMMANDS: Record<string, string> = {
  import: "./importBatch.js",
  "import-audio": "./importAudio.js",
  web: "./webServer.js",
  "set-auth": "./setAuth.js",
  "check-auth": "./checkAuth.js",
  probe: "./shareProbe.js",
  fetch: "./shareFetch.js",
};

/** command → a plain Node script (not TypeScript) to run in a child process. */
export const SCRIPTS: Record<string, string> = {
  "chrome-install": "../scripts/chrome-auth-install.mjs",
};

/** Short one-liners for `plaudport help`. */
export const SUMMARIES: Record<string, string> = {
  import: 'Archive + import share links, a file of them, or a recording on disk — "<link>" | links.txt | call.mp4',
  web: "Open the local web page (paste a link, click Import)",
  "set-auth": "Save/refresh the Plaud token from your clipboard",
  "check-auth": "Show whether your credentials work and when the token expires",
  probe: "Report what a share link exposes, without importing",
  fetch: "Archive a share locally without uploading",
  "import-audio": "Upload one already-archived recording (lower level)",
  "chrome-install": "Install the macOS Chrome credential-sync helper ([--uninstall])",
};

export function version(): string {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function usage(): string {
  const order = ["import", "web", "set-auth", "check-auth", "probe", "fetch", "import-audio", "chrome-install"];
  const width = Math.max(...order.map((c) => c.length));
  const lines = order.map((c) => `  plaudport ${c.padEnd(width)}  ${SUMMARIES[c]}`);
  return [
    "PlaudPort — import shared Plaud meetings and local recordings into your Plaud workspace.",
    "",
    "Usage: plaudport <command> [options]",
    "",
    ...lines,
    "",
    "Examples:",
    '  plaudport import "https://web.plaud.ai/s/pub_xxxx::xxxx"',
    "  plaudport import ~/Downloads/call.mp4 --title \"Acme sync\" --date \"2026-09-20 14:00\"",
    "  plaudport web",
    "",
    "plaudport --version   print the version",
    "plaudport help        show this",
  ].join("\n");
}

export type Resolution =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "module"; spec: string }
  | { kind: "script"; spec: string }
  | { kind: "unknown"; cmd: string };

/** Decide what a command word means, without running anything (unit-tested). */
export function resolveCommand(cmd: string | undefined): Resolution {
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return { kind: "help" };
  if (cmd === "-v" || cmd === "--version" || cmd === "version") return { kind: "version" };
  // Accept the npm-script spellings too, so muscle memory still works.
  const normalized = cmd.replace(/:/g, "-");
  if (COMMANDS[normalized]) return { kind: "module", spec: COMMANDS[normalized] };
  if (SCRIPTS[normalized]) return { kind: "script", spec: SCRIPTS[normalized] };
  return { kind: "unknown", cmd };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const r = resolveCommand(cmd);

  if (r.kind === "help") {
    console.log(usage());
    return;
  }
  if (r.kind === "version") {
    console.log(`plaudport ${version()}`);
    return;
  }
  if (r.kind === "unknown") {
    console.error(`Unknown command: ${r.cmd}\n`);
    console.error(usage());
    process.exit(1);
  }
  if (r.kind === "script") {
    const res = spawnSync(process.execPath, [join(here, r.spec), ...rest], { stdio: "inherit" });
    process.exit(res.status ?? 1);
  }

  // A module: give it the argv its own `main` expects (argv[2:] = the rest),
  // and set argv[1] to the module path so any "run only when invoked directly"
  // guard (e.g. in webServer.ts) still fires.
  process.argv = [process.argv[0]!, join(here, r.spec), ...rest];
  await import(r.spec);
}

// Run only when executed, not when imported by a test.
if (process.argv[1] && /[/\\]cli\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
