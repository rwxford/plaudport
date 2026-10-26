#!/usr/bin/env node
// Entry point installed on PATH (Homebrew, or `npm link`/`npx`). It runs the
// TypeScript CLI through tsx, so there is no build step to keep in sync.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");

// `node --import tsx <file>` is tsx's supported loader entry (Node >= 20.9).
const res = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], { stdio: "inherit" });

if (res.error && res.error.code === "ERR_MODULE_NOT_FOUND") {
  console.error("tsx isn't installed. From the PlaudPort folder, run: npm install");
  process.exit(1);
}
process.exit(res.status ?? 1);
