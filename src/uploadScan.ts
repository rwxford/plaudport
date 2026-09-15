import { config } from "./config.js";
import { capSize, redactValue } from "./redact.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Work out how Plaud's web app uploads audio into a workspace.
 *
 *   npm run scan:upload -- ~/Downloads/import.har
 *
 * Importing a file is usually several requests in order — ask the API for an
 * upload target, PUT the bytes somewhere, tell the API it finished — so this
 * prints the write requests **chronologically**, with the field names and JSON
 * keys each one carried. Sequence is the thing to see; a single endpoint out of
 * context is not enough to replicate the flow.
 *
 * Reports names and shapes, never values: a HAR of your own session contains
 * your Plaud bearer token, so nothing here prints header or body contents.
 */

interface HarEntry {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: {
      mimeType?: string;
      text?: string;
      params?: Array<{ name: string; value?: string; fileName?: string; contentType?: string }>;
    };
    bodySize?: number;
  };
  response?: {
    status?: number;
    headers?: Array<{ name: string; value: string }>;
    content?: { mimeType?: string; text?: string; size?: number };
  };
}

/** Telemetry and third-party noise — never part of an upload flow. */
const NOISE = [
  "posthog.com",
  "datadoghq.com",
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "stripe.com",
  "stripe.network",
  "cookieyes.com",
  "sentry.io",
  "github.com",
  "googleapis.com",
  "cloudflareinsights.com",
  "google.com",
  // Plaud's Sentry endpoint: crash telemetry, never part of an upload.
  "guardian-web.plaud.ai",
];

const isNoise = (host: string) => NOISE.some((n) => host === n || host.endsWith("." + n));

function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return "{id}";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return "{id}";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{id}";
      return seg;
    })
    .join("/");
}

const SHOW_BODY = process.argv.includes("--show-body");

/** Keys whose values are never printed, even with --show-body. */
const SECRET_KEY = /token|auth|secret|password|signature|credential|cookie|session_id|serial|key$/i;

/** Values of an API request body, with anything credential-shaped masked. */
function maskValues(v: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return typeof v === "string" ? `<masked:${v.length}>` : "<masked>";
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => maskValues(x));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskValues(x, k)]));
  }
  if (typeof v === "string" && v.length > 80) return `<string:${v.length}>`;
  return v;
}

/** What the request carried, described without quoting any of it. */
function describeBody(entry: HarEntry): { kind: string; detail: string } {
  const post = entry.request?.postData;
  const size = entry.request?.bodySize ?? 0;
  if (!post) return { kind: size > 0 ? "raw" : "none", detail: size > 0 ? `${size} bytes` : "" };

  const mime = post.mimeType ?? "";

  if (mime.includes("multipart/form-data")) {
    const fromParams = post.params?.map((p) => (p.fileName ? `${p.name}=<file ${p.contentType ?? "?"}>` : p.name));
    const fromText = post.text ? [...post.text.matchAll(/name="([^"]+)"/g)].map((m) => m[1]) : [];
    const fields = fromParams?.length ? fromParams : [...new Set(fromText)];
    return { kind: "multipart", detail: fields.length ? `fields: ${fields.join(", ")}` : "fields: (not captured)" };
  }

  if (mime.includes("json") && post.text) {
    try {
      const parsed = JSON.parse(post.text);
      const keys = Object.keys(parsed as object);
      if (SHOW_BODY) {
        // Values matter for replicating the flow (scene, file_type, is_tmp...).
        // Credential-shaped keys stay masked; S3 and telemetry never reach here.
        return { kind: "json", detail: JSON.stringify(maskValues(parsed)).slice(0, 600) };
      }
      return { kind: "json", detail: `keys: ${keys.join(", ")}` };
    } catch {
      return { kind: "json", detail: "unparseable body" };
    }
  }

  if (/^(audio|video|application\/octet-stream|binary)/i.test(mime)) {
    return { kind: "binary", detail: `${mime}, ${size || post.text?.length || "?"} bytes` };
  }

  return { kind: mime || "unknown", detail: size ? `${size} bytes` : "" };
}

function responseShape(entry: HarEntry): unknown {
  const c = entry.response?.content;
  if (!c?.text || !c.mimeType?.includes("json")) return undefined;
  try {
    return capSize(redactValue(JSON.parse(c.text)), 900);
  } catch {
    return undefined;
  }
}

function main() {
  const harPath = process.argv[2];
  if (!harPath) {
    console.error("Usage: npm run scan:upload -- <path-to-.har>\nSee docs/CAPTURE-UPLOAD.md.");
    process.exit(1);
  }

  let har: { log?: { entries?: HarEntry[] } };
  try {
    har = JSON.parse(readFileSync(harPath, "utf8"));
  } catch (e) {
    console.error(`Could not read HAR at ${harPath}: ${String(e)}`);
    process.exit(1);
  }

  const entries = har.log?.entries ?? [];
  const writes = entries
    .filter((e) => {
      const method = (e.request?.method ?? "GET").toUpperCase();
      const url = e.request?.url;
      if (!url) return false;
      // CORS preflights carry no information about the flow.
      if (method === "OPTIONS") return false;
      let host: string;
      try {
        host = new URL(url).host.toLowerCase();
      } catch {
        return false;
      }
      if (isNoise(host)) return false;
      if (/\.(js|css|png|jpe?g|svg|woff2?|ico|map)$/i.test(new URL(url).pathname)) return false;
      // Writes, plus reads that smell like part of an upload handshake.
      if (["POST", "PUT", "PATCH"].includes(method)) return true;
      return /upload|presign|temp_url|complete|create|import/i.test(url);
    })
    .sort((a, b) => String(a.startedDateTime).localeCompare(String(b.startedDateTime)));

  if (writes.length === 0) {
    console.error("\nNo write requests found in this HAR.");
    console.error("Did the import actually run while the Network tab was recording?");
    process.exit(1);
  }

  console.log(`\n=== Upload flow: ${writes.length} write request(s), in order ===\n`);

  const records = writes.map((e, i) => {
    const url = new URL(e.request!.url!);
    const method = (e.request?.method ?? "GET").toUpperCase();
    const body = describeBody(e);
    const status = e.response?.status ?? null;
    const shape = responseShape(e);
    // ALL header names, not a curated subset: the credential may be one we did
    // not think to look for (a cookie, say), and a name is not a secret.
    const customHeaders = (e.request?.headers ?? [])
      .map((h) => h.name.toLowerCase())
      .filter((n) => !n.startsWith(":") && !["accept", "accept-encoding", "accept-language", "user-agent", "referer", "origin", "priority"].includes(n) && !n.startsWith("sec-"));

    console.log(`[${i}] ${method} ${url.host}${templatePath(url.pathname)}`);
    console.log(`     status ${status ?? "?"}  |  body: ${body.kind}${body.detail ? ` (${body.detail})` : ""}`);
    if (url.search) console.log(`     query: ${[...url.searchParams.keys()].join(", ")}`);
    if (customHeaders.length) console.log(`     headers: ${[...new Set(customHeaders)].join(", ")}`);
    if (shape !== undefined) console.log(`     response: ${JSON.stringify(shape).slice(0, 400)}`);
    const respHeaders = (e.response?.headers ?? [])
      .map((h) => h.name.toLowerCase())
      .filter((n) => ["etag", "location", "x-amz-version-id"].includes(n));
    if (respHeaders.length) console.log(`     response headers: ${respHeaders.join(", ")}`);
    console.log();

    return {
      order: i,
      method,
      host: url.host,
      path: templatePath(url.pathname),
      queryKeys: [...url.searchParams.keys()],
      requestBody: body,
      headerNames: [...new Set(customHeaders)],
      status,
      responseShape: shape ?? null,
    };
  });

  mkdirSync(config.dataDir, { recursive: true });
  const out = join(config.dataDir, "upload-scan.json");
  writeFileSync(out, JSON.stringify({ scannedAt: new Date().toISOString(), requests: records }, null, 2));

  console.log(`Wrote ${out}`);
  if (SHOW_BODY) {
    console.log("Request bodies shown with credential-shaped values masked. Skim before pasting.");
  } else {
    console.log("Names and shapes only — no header values, no body contents, no token.");
    console.log("Re-run with --show-body to include API request values (still masks anything secret).");
  }
  console.log("Safe to paste the output above back to me.");
}

main();
