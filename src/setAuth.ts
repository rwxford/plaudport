import { unwrapValue } from "./env.js";
import { upsertEnvLine } from "./envFile.js";
import { readTokenExpiry } from "./jwt.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Refresh the expiring Plaud credential in one command.
 *
 *   npm run set:auth              # takes the value from the clipboard
 *   npm run set:auth -- "Bearer eyJ…"
 *
 * Plaud's bearer lasts about a day, so this happens often enough that editing
 * .env by hand each time is the most tedious part of using the tool. Copy the
 * `authorization` value in DevTools, run this, done.
 */

const ENV_PATH = ".env";

function fromClipboard(): string {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    console.error("Could not read the clipboard (pbpaste is macOS-only).");
    console.error('Pass the value instead:  npm run set:auth -- "Bearer eyJ…"');
    process.exit(1);
  }
}

function main() {
  const fromArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const value = unwrapValue(fromArg ?? fromClipboard());

  if (!value) {
    console.error("Nothing to set — the clipboard was empty.");
    process.exit(1);
  }

  const expiry = readTokenExpiry(value);
  if (!expiry) {
    console.error("That does not look like a Plaud bearer token (expected a JWT with three dot-separated parts).");
    console.error("In DevTools: any api.plaud.ai request → Headers → Request Headers → authorization → copy the value.");
    console.error(`Got ${value.length} characters starting "${value.slice(0, 12)}…".`);
    process.exit(1);
  }
  if (expiry.expired) {
    console.error(`That token expired ${expiry.relative}. Copy a current one — reload web.plaud.ai first.`);
    process.exit(1);
  }

  const before = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  writeFileSync(ENV_PATH, upsertEnvLine(before, "PLAUD_AUTH", value));

  console.log(`\nPLAUD_AUTH updated in ${ENV_PATH}.`);
  console.log(`Expires ${expiry.relative} (${expiry.expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC).`);
}

main();
