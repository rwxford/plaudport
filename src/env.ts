import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal .env loading.
 *
 * Every command reads its settings from the environment, and people reasonably
 * expect `.env` to be the place those live — `.env.example` says so. Nothing was
 * actually reading it until credentials were needed, which is a silent failure
 * of the worst kind: the file is right, the value is right, and the tool insists
 * it is unset.
 *
 * Real environment variables always win, so `PLAUD_USER_TOKEN=... npm run ...`
 * overrides the file for a single run.
 */

export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Tolerate `export FOO=bar`, which people paste out of shell docs.
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    // Strip matching quotes; leave inner ones alone.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values can carry a trailing comment.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Strip wrappers people paste along with a credential: angle brackets from a
 * placeholder like <paste-here>, surrounding quotes, and stray whitespace.
 * Copying the brackets is an easy mistake and produces a baffling error from the
 * far end ("invalid auth header") rather than anything pointing at the cause.
 */
export function unwrapValue(value: string): string {
  let v = value.trim();
  for (const [open, close] of [["<", ">"], ['"', '"'], ["'", "'"], ["`", "`"]]) {
    if (v.length >= 2 && v.startsWith(open!) && v.endsWith(close!)) v = v.slice(1, -1).trim();
  }
  return v;
}

/** Current Chrome credentials override stale local copies; explicit shell values win. */
export function mergeEnvironment(
  explicit: Record<string, string | undefined>,
  local: Record<string, string>,
  chrome: Record<string, string>,
): Record<string, string> {
  const merged = { ...local };
  for (const key of ["PLAUD_AUTH", "PLAUD_USER_TOKEN", "PLAUD_DEVICE_ID"]) {
    if (chrome[key]) merged[key] = chrome[key]!;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

function readSettings(path: string): Record<string, string> {
  try { return parseEnv(readFileSync(path, "utf8")); }
  catch { return {}; }
}

/** Load local settings and the optional macOS Chrome credential store. */
export function loadEnvFile(path = ".env"): void {
  const local = readSettings(path);
  const chrome = process.platform === "darwin" && path === ".env"
    ? readSettings(join(homedir(), "Library/Application Support/PlaudPort/chrome-auth.env"))
    : {};
  const merged = mergeEnvironment(process.env, local, chrome);
  for (const [key, value] of Object.entries(merged)) process.env[key] = value;
}

/** Credentials a `set:auth` or a fresh capture rewrites in `.env`. */
export const CREDENTIAL_KEYS = ["PLAUD_AUTH", "PLAUD_USER_TOKEN", "PLAUD_DEVICE_ID", "PLAUD_COOKIE"] as const;

/**
 * Re-read the credential sources so a long-running process (the web UI) picks up
 * a token refreshed since startup — by `npm run set:auth` into `.env`, or by the
 * Chrome extension into its store — without a restart.
 *
 * Same source precedence as `loadEnvFile`: the Chrome store wins over `.env`.
 * Only a non-empty value overwrites, so the empty credential lines a Chrome-sync
 * `.env` carries can't wipe a live Chrome session, and a credential that lives
 * only in the process environment (a shell export) is left alone when the files
 * offer nothing. A no-op when no source provides the key.
 */
export function reloadCredentialsFromEnvFile(path = ".env"): void {
  const local = readSettings(path);
  const chrome =
    process.platform === "darwin" && path === ".env"
      ? readSettings(join(homedir(), "Library/Application Support/PlaudPort/chrome-auth.env"))
      : {};
  for (const key of CREDENTIAL_KEYS) {
    const next = chrome[key] || local[key]; // Chrome wins; empty/absent is ignored
    if (next) process.env[key] = next;
  }
}
