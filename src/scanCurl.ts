import { parseCurl } from "./curl.js";
import { readTokenExpiry } from "./jwt.js";
import { execFileSync } from "node:child_process";

/**
 * Describe a request copied from DevTools, without disclosing its credentials.
 *
 *   npm run scan:curl                 # reads the clipboard
 *   npm run scan:curl -- "curl '…'"
 *
 * "Copy as cURL" is the reliable way to capture one request when a HAR export
 * arrives sanitized — but the command itself contains live credentials. This
 * prints what is useful for reverse-engineering an endpoint (method, path, which
 * headers, which body fields) and masks what is not ours to share.
 *
 * The output is safe to paste into a chat. The input never is.
 */

/** Values worth showing: app constants that carry no secret. */
const SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "app-language",
  "app-platform",
  "content-type",
  "edit-from",
  "origin",
  "referer",
  "timezone",
]);

const SECRET_FIELD = /pass|token|secret|auth|code|otp|pin|key$/i;

function maskValue(key: string, value: unknown): unknown {
  if (SECRET_FIELD.test(key)) return typeof value === "string" ? `<masked:${value.length}>` : "<masked>";
  if (typeof value === "string") {
    // Emails and anything long are identifying; report the shape instead.
    if (/@/.test(value)) return `<email:${value.length}>`;
    return value.length > 40 ? `<string:${value.length}>` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 2).map((v) => maskValue(key, v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(k, v)]));
  }
  return value;
}

function main() {
  const fromArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  let command = fromArg ?? "";
  if (!command) {
    try {
      command = execFileSync("pbpaste", { encoding: "utf8" });
    } catch {
      console.error("Could not read the clipboard (pbpaste is macOS-only).");
      console.error("Pass the command instead:  npm run scan:curl -- \"curl '…'\"");
      process.exit(1);
    }
  }

  let parsed;
  try {
    parsed = parseCurl(command);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }

  const url = new URL(parsed.url);
  console.log(`\n${parsed.method} ${url.host}${url.pathname}`);

  if (parsed.method === "OPTIONS") {
    console.log("\n  This is the CORS preflight, not the request itself — it carries no credentials");
    console.log("  and no body. In the Network list the real request sits right below it, same");
    console.log("  name, method POST or GET. Right-click THAT one and copy it instead.");
    console.log("  (Right-click the column headers → Method, to see the method at a glance.)");
  }
  if (url.search) console.log(`  query: ${[...url.searchParams.keys()].join(", ")}`);

  console.log("\nHeaders:");
  for (const name of parsed.headerNames.sort()) {
    const value = parsed.headers[name] ?? "";
    if (SAFE_HEADERS.has(name)) {
      console.log(`  ${name}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`);
    } else {
      const expiry = name === "authorization" ? readTokenExpiry(value) : null;
      const note = expiry ? `, JWT ${expiry.expired ? "EXPIRED" : "expires"} ${expiry.relative}` : "";
      console.log(`  ${name}: <${value.length} chars${note}>`);
    }
  }

  if (parsed.body) {
    console.log("\nRequest body:");
    try {
      const json = JSON.parse(parsed.body);
      console.log(`  ${JSON.stringify(maskValue("", json))}`);
    } catch {
      // Form-encoded or opaque: report field names only.
      const fields = [...parsed.body.matchAll(/(^|&)([^=&]+)=/g)].map((m) => m[2]);
      console.log(fields.length ? `  form fields: ${fields.join(", ")}` : `  <${parsed.body.length} bytes, not JSON>`);
    }
  }

  console.log("\nValues are masked — this output is safe to share. The cURL command is not.");
}

main();
