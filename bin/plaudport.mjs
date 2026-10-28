#!/usr/bin/env node
// Entry point installed on PATH (Homebrew, or `npm link`/`npx`). It runs the
// TypeScript CLI through tsx, so there is no build step to keep in sync.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");

// A bare `--import tsx` is resolved against the *caller's* working directory,
// not this file's location, so it only worked from inside the repo. Resolve tsx
// from this install and hand Node an absolute file URL instead. The child keeps
// the caller's cwd, so relative paths (e.g. `plaudport import ./file.mp3`) still
// resolve where the user ran the command.
let tsxImport;
try {
  tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
} catch {
  console.error("tsx isn't installed. Reinstall PlaudPort (brew reinstall plaudport), or from the PlaudPort folder run: npm install");
  process.exit(1);
}

// `node --import <tsx> <file>` is tsx's supported loader entry (Node >= 20.9).
const res = spawnSync(process.execPath, ["--import", tsxImport, cli, ...process.argv.slice(2)], { stdio: "inherit" });

if (res.error) {
  console.error(`Could not start PlaudPort: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
