import { config, isAllowedHost } from "./config.js";
import { capSize, redactValue } from "./redact.js";
import { describeShare, parseShareUrl, ShareUrlError, type ShareRef } from "./shareUrl.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Recon for a Plaud public share link.
 *
 *   npm run probe:share -- "https://web.plaud.ai/s/pub_...::token"
 *
 * Answers the question the share-import feature is blocked on: what does a public
 * share page actually expose — audio, transcript, summary, or only a rendered
 * page? Requires no Plaud login, because a share link works logged out.
 *
 * OUTPUT POLICY: this reports *structure*, never meeting content. The shared
 * recording belongs to someone else; the report keeps field names, URL shapes,
 * content types and sizes, and says whether text is present without quoting it.
 * Pass --raw to see actual values locally when debugging (never paste that
 * anywhere). The access token is never printed in full either way.
 */

interface Finding {
  kind: string;
  detail: string;
  url?: string;
}

interface ProbeReport {
  probedAt: string;
  shareId: string;
  page: { status: number | null; contentType: string | null; bytes: number | null; note?: string };
  metaTags: Record<string, string>;
  metaHosts?: string[];
  scripts: string[];
  embeddedJsonKeys: string[];
  mediaUrls: string[];
  apiPathCandidates: string[];
  endpointProbes: Array<{ url: string; status: number | null; contentType: string | null; shape?: unknown; note?: string }>;
  findings: Finding[];
}

const SHOW_RAW = process.argv.includes("--raw");

/**
 * Plaud serves a tiny meta-tags-only stub to anything that doesn't look like a
 * browser — good for link previews in Slack, useless for finding the real app.
 * Identifying as a browser gets the same page a person would see, which is the
 * page whose behaviour we are trying to understand.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function redactText(s: string, label: string): string {
  return SHOW_RAW ? s : `<${label}:${s.length} chars>`;
}

async function fetchText(url: string): Promise<{ status: number; contentType: string | null; body: string }> {
  const host = new URL(url).host;
  if (!isAllowedHost(host)) throw new Error(`SSRF guard: host not allowlisted: ${host.toLowerCase()}`);
  const res = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": BROWSER_UA,
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
}

/**
 * Hosts referenced by meta tags — og:image usually points at the media/thumbnail
 * CDN, which is exactly the host the audio download will need allowlisted.
 */
function hostsInMeta(html: string): string[] {
  const hosts = new Set<string>();
  for (const m of html.matchAll(/content=["'](https?:\/\/[^"']+)["']/gi)) {
    const v = m[1];
    if (!v) continue;
    try {
      hosts.add(new URL(v).host.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return [...hosts];
}

function extractMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']*)["']/gi;
  for (const m of html.matchAll(re)) {
    const key = m[1];
    const val = m[2];
    if (!key || val === undefined) continue;
    if (!/^(og:|twitter:|description|title)/i.test(key)) continue;
    out[key] = redactText(val, "meta");
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (title?.[1]) out["<title>"] = redactText(title[1], "title");
  return out;
}

function extractScripts(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (!src) continue;
    try {
      out.add(new URL(src, base).toString());
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/** Top-level keys of any inline JSON blob — tells us if the page ships its data. */
function extractEmbeddedJson(html: string): { keys: string[]; shapes: unknown[] } {
  const keys = new Set<string>();
  const shapes: unknown[] = [];
  const patterns = [
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (!m?.[1]) continue;
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const k of Object.keys(parsed as object)) keys.add(k);
      shapes.push(capSize(redactValue(parsed), 1500));
    } catch {
      /* not JSON, skip */
    }
  }
  return { keys: [...keys], shapes };
}

function extractMediaUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+\.(?:mp3|m4a|wav|aac|ogg|flac|mp4)(?:\?[^\s"'<>\\]*)?/gi)) {
    out.add(m[0]);
  }
  return [...out];
}

/** Path-like strings mentioning share/pub inside a JS bundle — the real endpoint map. */
function extractApiPaths(js: string): string[] {
  const out = new Set<string>();
  for (const m of js.matchAll(/["'`](\/[A-Za-z0-9_\-/{}.:]*(?:share|pub|public)[A-Za-z0-9_\-/{}.:]*)["'`]/gi)) {
    const p = m[1];
    if (p && p.length < 120) out.add(p);
  }
  for (const m of js.matchAll(/["'`](https?:\/\/[a-z0-9.-]*plaud\.ai[A-Za-z0-9_\-/{}.:]*)["'`]/gi)) {
    const u = m[1];
    if (u && u.length < 160) out.add(u);
  }
  return [...out];
}

async function probeEndpoint(url: string): Promise<ProbeReport["endpointProbes"][number]> {
  try {
    const { status, contentType, body } = await fetchText(url);
    let shape: unknown;
    if (contentType?.includes("json")) {
      try {
        shape = capSize(redactValue(JSON.parse(body)), 1500);
      } catch {
        shape = undefined;
      }
    }
    return { url, status, contentType, shape };
  } catch (e) {
    return { url, status: null, contentType: null, note: String((e as Error).message ?? e) };
  }
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!arg) {
    console.error('Usage: npm run probe:share -- "<share url>" [--raw]');
    process.exit(1);
  }

  let ref: ShareRef;
  try {
    ref = parseShareUrl(arg);
  } catch (e) {
    if (e instanceof ShareUrlError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  console.log(`\n=== Probing share ${describeShare(ref)} ===\n`);

  const findings: Finding[] = [];
  const report: ProbeReport = {
    probedAt: new Date().toISOString(),
    shareId: ref.shareId,
    page: { status: null, contentType: null, bytes: null },
    metaTags: {},
    scripts: [],
    embeddedJsonKeys: [],
    mediaUrls: [],
    apiPathCandidates: [],
    endpointProbes: [],
    findings,
  };

  // --- 1. the share page itself ---
  let html = "";
  try {
    const page = await fetchText(ref.url);
    html = page.body;
    report.page = { status: page.status, contentType: page.contentType, bytes: page.body.length };
    console.log(`Page: HTTP ${page.status}, ${page.contentType ?? "?"}, ${page.body.length} bytes`);

    if (page.status !== 200) {
      // Anything but 200 means we are not looking at a share page, and every
      // conclusion below would be drawn from an error page. Stop here.
      findings.push({ kind: "page", detail: `share page returned HTTP ${page.status}` });
      console.error(`\nThat is not a share page. HTTP ${page.status} usually means one of:`);
      if (page.status === 403 || page.status === 401) {
        console.error("  - the link was revoked, or its access token is wrong/truncated");
        console.error("  - something between you and Plaud is blocking web.plaud.ai (proxy, VPN, DNS filter)");
      } else if (page.status === 404) {
        console.error("  - the share was deleted, or the id is wrong");
      } else if (page.status >= 500) {
        console.error("  - Plaud is having trouble; try again shortly");
      }
      console.error("  Open the link in a browser: if it loads there but fails here, it is your network.");
      writeReport(ref, report);
      process.exit(1);
    }
  } catch (e) {
    report.page.note = String((e as Error).message ?? e);
    console.error(`Could not fetch the share page: ${report.page.note}`);
    console.error("If this is a network/proxy error, run it again on a normal connection.");
    process.exit(1);
  }

  // --- 2. what the HTML already carries ---
  report.metaTags = extractMeta(html);
  if (Object.keys(report.metaTags).length) {
    console.log("\nMeta tags (content redacted unless --raw):");
    for (const [k, v] of Object.entries(report.metaTags)) console.log(`  ${k}: ${v}`);
    if (report.metaTags["og:audio"]) findings.push({ kind: "audio", detail: "page advertises og:audio" });

    const metaHosts = hostsInMeta(html);
    if (metaHosts.length) {
      console.log("\nHosts referenced by those tags (og:image is usually the media CDN):");
      for (const h of metaHosts) {
        console.log(`  ${h}${isAllowedHost(h) ? "  [allowlisted]" : "  <- add to PLAUD_ALLOWED_HOSTS to fetch from here"}`);
      }
      report.metaHosts = metaHosts;
    }
  }

  const embedded = extractEmbeddedJson(html);
  report.embeddedJsonKeys = embedded.keys;
  if (embedded.keys.length) {
    console.log(`\nEmbedded JSON in the page, top-level keys: ${embedded.keys.join(", ")}`);
    findings.push({ kind: "data", detail: "share data is embedded in the HTML — no separate API call needed" });
  } else {
    console.log("\nNo inline JSON blob found — the page likely fetches its data from an API.");
  }

  const transcriptish = /transcript|utterance|speaker|summary/i.test(html);
  console.log(
    transcriptish
      ? "Transcript-ish words appear in the HTML (may be labels rather than content)."
      : "No transcript-ish words in the HTML — content is almost certainly loaded by JavaScript.",
  );

  report.mediaUrls = extractMediaUrls(html).map((u) => (SHOW_RAW ? u : u.split("?")[0] ?? u));
  if (report.mediaUrls.length) {
    console.log(`\nMedia URLs in the page (query strings stripped): ${report.mediaUrls.length}`);
    for (const u of report.mediaUrls.slice(0, 5)) console.log(`  ${u}`);
    findings.push({ kind: "audio", detail: `${report.mediaUrls.length} media URL(s) found in the HTML` });
  }

  // --- 3. the JS bundles, where the endpoint paths live ---
  report.scripts = extractScripts(html, ref.url);
  console.log(`\nScripts referenced: ${report.scripts.length}`);
  if (report.scripts.length === 0 && html.length < 8000) {
    console.log("  A page this small with no scripts is the link-preview stub, not the real app.");
    console.log("  Plaud decides what to serve from the request's identity; the HAR capture is definitive either way.");
    findings.push({ kind: "page", detail: "served the link-preview stub rather than the app shell" });
  }
  const paths = new Set<string>();
  let scanned = 0;
  for (const src of report.scripts) {
    if (scanned >= 4) break;
    let host: string;
    try {
      host = new URL(src).host;
    } catch {
      continue;
    }
    if (!isAllowedHost(host)) {
      console.log(`  skipped (host not allowlisted): ${host}`);
      continue;
    }
    try {
      const js = await fetchText(src);
      scanned++;
      for (const p of extractApiPaths(js.body)) paths.add(p);
      for (const m of extractMediaUrls(js.body)) report.mediaUrls.push(SHOW_RAW ? m : m.split("?")[0] ?? m);
    } catch {
      /* skip unreadable bundle */
    }
  }
  report.apiPathCandidates = [...paths];
  if (paths.size) {
    console.log(`\nShare-related API paths found in the JS (${scanned} bundle(s) scanned):`);
    for (const p of report.apiPathCandidates) console.log(`  ${p}`);
  } else if (scanned > 0) {
    console.log("\nNo share-related paths found in the scanned bundles.");
  }

  // --- 4. try the most likely endpoints ---
  const candidates = new Set<string>();
  for (const p of report.apiPathCandidates) {
    if (!p.startsWith("/")) continue;
    if (p.includes("{") || p.includes(":")) continue; // templates need values we don't know yet
    for (const base of ["https://api.plaud.ai", "https://web.plaud.ai"]) {
      candidates.add(`${base}${p}/${ref.shareId}`);
      candidates.add(`${base}${p}?id=${ref.shareId}&token=${ref.accessToken}`);
    }
  }
  if (candidates.size) {
    console.log(`\nTrying ${Math.min(candidates.size, 8)} candidate endpoint(s):`);
    for (const url of [...candidates].slice(0, 8)) {
      const probe = await probeEndpoint(url);
      report.endpointProbes.push(probe);
      const shown = SHOW_RAW ? url : url.replace(ref.accessToken, "<token>");
      console.log(`  ${probe.status ?? "ERR"}  ${probe.contentType ?? ""}  ${shown}`);
      if (probe.status === 200 && probe.contentType?.includes("json")) {
        findings.push({ kind: "api", detail: "a candidate endpoint returned JSON", url: shown });
      }
    }
  }

  // --- 5. verdict ---
  console.log("\n--- what this means ---");
  if (findings.some((f) => f.kind === "audio")) {
    console.log("AUDIO: found media URL(s) — importing as a real recording looks possible.");
  } else {
    console.log("AUDIO: none found yet. Either it is loaded dynamically, or share links are text-only.");
    console.log("       Next step: open the link in a logged-out browser window with DevTools > Network,");
    console.log("       play the audio, save a HAR, then run:  npm run scan:har -- <file.har>");
  }
  if (findings.some((f) => f.kind === "data" || f.kind === "api")) {
    console.log("DATA:  a machine-readable source for the transcript looks reachable.");
  } else {
    console.log("DATA:  no JSON source confirmed yet — the HAR step above will settle it.");
  }

  writeReport(ref, report);
}

function writeReport(ref: ShareRef, report: ProbeReport) {
  mkdirSync(config.dataDir, { recursive: true });
  const out = join(config.dataDir, `share-probe-${ref.shareId}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(SHOW_RAW ? "RAW MODE — this report contains real content. Do not share it." : "Structure only — safe to paste back.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
