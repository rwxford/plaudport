import { config } from "./config.js";
import { capSize, redactValue } from "./redact.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Endpoint discovery from a DevTools HAR export.
 *
 *   npm run scan:har -- ~/Downloads/web.plaud.ai.har
 *
 * Reads a HAR entirely locally, groups the API calls into path templates, and
 * prints a candidate endpoint map to paste into src/config.ts. This replaces
 * transcribing paths by hand out of the Network tab.
 *
 * SAFETY: a HAR contains your bearer token, your recording ids, and often whole
 * response bodies. This scanner never copies header values or body content into
 * its output — only methods, path templates, parameter *names*, status codes and
 * redacted response shapes. Delete the .har when you are done with it; `*.har`
 * is gitignored so it cannot be committed by accident.
 */

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    queryString?: HarHeader[];
  };
  response?: {
    status?: number;
    content?: { mimeType?: string; text?: string; size?: number };
  };
  _resourceType?: string;
}

/** Path segments that are clearly identifiers become {id} so calls collapse together. */
export function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return "{id}";
      if (/^[0-9a-f]{8,}$/i.test(seg)) return "{id}";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{id}";
      // long opaque tokens: mixed case/digits, no vowel-ish word shape
      if (seg.length >= 16 && /\d/.test(seg) && /[A-Za-z]/.test(seg) && !seg.includes(".")) return "{id}";
      return seg;
    })
    .join("/");
}

/** Which config.endpoints slot a path most likely belongs to. */
export function suggestSlot(method: string, path: string): string | null {
  const p = path.toLowerCase();
  const isPost = method === "POST" || method === "PUT" || method === "PATCH";
  if (/\b(me|profile|account|user)\b/.test(p) && !isPost) return "me";
  if (/(workspace|space|team|org)/.test(p) && !isPost) return "workspaces";
  if (/(transcript|asr|speech)/.test(p)) return "transcript";
  if (/(summary|summari|note|ai-?content|action-?item)/.test(p)) return "summary";
  if (/(regenerate|re-?run|retry|generate)/.test(p) && isPost) return "regenerate";
  if (/(upload|import|create).*(file|audio|record)|(file|audio|record).*(upload|import)/.test(p) && isPost)
    return "importAudio";
  if (/(download|audio|media|stream|\/url)/.test(p) && !isPost) return "audioDownload";
  // Collection endpoints: /file/list, /records/page, /items/search, /files
  if (/(record|file|note|item)s?\/(list|page|search|query)\b/.test(p) && !isPost) return "recordings";
  if (/(record|file|note|item)s\b(?!\/)/.test(p) && !isPost) return "recordings";
  // Single item: /file/{id}, /recordings/{id}
  if (/(record|file|note|item)s?\/\{id\}$/.test(p) && !isPost) return "recordingDetail";
  return null;
}

interface Group {
  method: string;
  host: string;
  path: string;
  count: number;
  statuses: Set<number>;
  queryParams: Set<string>;
  authenticated: boolean;
  customHeaders: Set<string>;
  shape?: unknown;
}

function parseBodyShape(entry: HarEntry): unknown {
  const content = entry.response?.content;
  if (!content?.text) return undefined;
  if (content.mimeType && !content.mimeType.includes("json")) return undefined;
  try {
    // Always redact here regardless of PLAUD_REDACT_SAMPLES: a HAR is far more
    // likely to be shared than a spike report, and the shape is the useful part.
    return capSize(redactValue(JSON.parse(content.text)), 1200);
  } catch {
    return undefined;
  }
}

function main() {
  const harPath = process.argv[2];
  if (!harPath) {
    console.error("Usage: npm run scan:har -- <path-to-.har>\nSee docs/ENDPOINTS.md.");
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
  if (entries.length === 0) {
    console.error("No entries in this HAR. Re-record with the Network tab open and 'Preserve log' on.");
    process.exit(1);
  }

  const groups = new Map<string, Group>();
  const hostCounts = new Map<string, number>();
  let skippedNonApi = 0;

  for (const entry of entries) {
    const rawUrl = entry.request?.url;
    const method = (entry.request?.method ?? "GET").toUpperCase();
    if (!rawUrl) continue;

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }

    hostCounts.set(url.host, (hostCounts.get(url.host) ?? 0) + 1);

    // Static assets are noise; keep XHR/fetch and anything that returned JSON.
    const mime = entry.response?.content?.mimeType ?? "";
    const isApiish =
      entry._resourceType === "xhr" ||
      entry._resourceType === "fetch" ||
      mime.includes("json") ||
      method !== "GET";
    if (!isApiish || /\.(js|css|png|jpe?g|svg|woff2?|ico|map)$/i.test(url.pathname)) {
      skippedNonApi++;
      continue;
    }

    const path = templatePath(url.pathname);
    const key = `${method} ${url.host}${path}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        method,
        host: url.host,
        path,
        count: 0,
        statuses: new Set(),
        queryParams: new Set(),
        authenticated: false,
        customHeaders: new Set(),
      };
      groups.set(key, g);
    }

    g.count++;
    if (entry.response?.status) g.statuses.add(entry.response.status);
    for (const [name] of url.searchParams) g.queryParams.add(name);
    for (const h of entry.request?.headers ?? []) {
      const n = h.name.toLowerCase();
      if (n === "authorization" || n === "cookie") g.authenticated = true;
      // Header NAMES only — never values.
      if (n.startsWith("x-")) g.customHeaders.add(h.name.toLowerCase());
    }
    if (g.shape === undefined) g.shape = parseBodyShape(entry);
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  // ---- report ----
  console.log(`\n=== HAR scan: ${entries.length} entries (${skippedNonApi} non-API skipped) ===\n`);

  console.log("Hosts seen:");
  for (const [host, n] of [...hostCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const known = config.allowedHosts.some((h) => host === h || host.endsWith("." + h));
    console.log(`  ${host}  (${n})${known ? "  [allowlisted]" : "  <- add to PLAUD_ALLOWED_HOSTS if this is the API"}`);
  }

  console.log("\nCandidate endpoints:");
  const suggestions = new Map<string, string>();
  for (const g of sorted) {
    const slot = suggestSlot(g.method, g.path);
    if (slot && !suggestions.has(slot)) suggestions.set(slot, g.path);
    const bits = [
      `${g.method.padEnd(6)} ${g.path}`,
      `x${g.count}`,
      `status ${[...g.statuses].join("/") || "?"}`,
      g.authenticated ? "auth" : "no-auth",
    ];
    if (g.queryParams.size) bits.push(`query: ${[...g.queryParams].join(",")}`);
    if (g.customHeaders.size) bits.push(`headers: ${[...g.customHeaders].join(",")}`);
    if (slot) bits.push(`→ ${slot}?`);
    console.log(`  ${bits.join("  |  ")}`);
  }

  console.log("\nSuggested src/config.ts endpoints (VERIFY each one — these are keyword guesses):");
  for (const [slot, path] of suggestions) console.log(`    ${slot}: "${path}",`);
  if (suggestions.size === 0) console.log("    (nothing matched the keyword heuristics — map by hand from the list above)");

  mkdirSync(config.dataDir, { recursive: true });
  const outPath = join(config.dataDir, "har-scan.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        entryCount: entries.length,
        hosts: Object.fromEntries(hostCounts),
        endpoints: sorted.map((g) => ({
          method: g.method,
          host: g.host,
          path: g.path,
          count: g.count,
          statuses: [...g.statuses],
          queryParams: [...g.queryParams],
          customHeaders: [...g.customHeaders],
          authenticated: g.authenticated,
          suggestedSlot: suggestSlot(g.method, g.path),
          responseShape: g.shape ?? null,
        })),
      },
      null,
      2,
    ),
  );

  console.log(`\nWrote ${outPath} (paths and redacted shapes only — no tokens, no content).`);
  console.log("Delete the .har when you're done: it still contains your bearer token.");
}

main();
