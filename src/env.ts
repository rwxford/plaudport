import { existsSync, readFileSync } from "node:fs";

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

/** Load `.env` into process.env without clobbering anything already set. */
export function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
}
