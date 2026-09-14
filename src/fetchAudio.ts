import { config, isAllowedHost } from "./config.js";
import type { MediaRequest } from "./harScan.js";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Download a media file (the audio behind a Plaud share page) to local disk.
 *
 *   npm run fetch:audio -- --from-scan            # largest audio found by scan:har
 *   npm run fetch:audio -- "https://.../file.mp3" # an explicit URL
 *
 * A Plaud share page plays audio but offers no download link. The browser still
 * fetches it over HTTP, so `scan:har` records that request and this downloads it.
 * Streams to disk — a two-hour meeting never sits in memory — and records size
 * and sha256 so the file can be verified later.
 *
 * Signed media URLs usually expire within hours. If this 403s, re-record the HAR.
 */

interface Manifest {
  fetchedAt: string;
  sourceUrl: string;
  sourceHost: string;
  contentType: string | null;
  bytes: number;
  sha256: string;
  file: string;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const fromScan = argv.includes("--from-scan");
  const allowAnyHost = argv.includes("--allow-host");
  const outIdx = argv.indexOf("--out");
  const out = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const indexIdx = argv.indexOf("--index");
  const index = indexIdx !== -1 ? Number(argv[indexIdx + 1]) : 0;
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  return { fromScan, allowAnyHost, out, index, url };
}

function pickFromScan(index: number): string {
  const scanPath = join(config.dataDir, "har-scan.json");
  if (!existsSync(scanPath)) {
    console.error(`No scan found at ${scanPath}.`);
    console.error("Run this first:  npm run scan:har -- <your.har>");
    process.exit(1);
  }
  let scan: { mediaRequests?: MediaRequest[] };
  try {
    scan = JSON.parse(readFileSync(scanPath, "utf8"));
  } catch (e) {
    console.error(`Could not read ${scanPath}: ${String(e)}`);
    process.exit(1);
  }

  const media = (scan.mediaRequests ?? []).filter((m) => !m.isPlaylist);
  if (media.length === 0) {
    console.error("That scan found no downloadable audio.");
    if ((scan.mediaRequests ?? []).some((m) => m.isPlaylist)) {
      console.error("It did find a streaming playlist (.m3u8) — those need ffmpeg to stitch. Ask for that support.");
    } else {
      console.error("Re-record the HAR with the Network tab open and actually play the recording.");
    }
    process.exit(1);
  }
  const chosen = media[index];
  if (!chosen) {
    console.error(`No media at index ${index}; the scan has ${media.length} (0-${media.length - 1}).`);
    process.exit(1);
  }
  const size = chosen.bytes ? `${(chosen.bytes / 1_048_576).toFixed(1)} MB` : "size unknown";
  console.log(`Using [${index}] ${chosen.mimeType ?? "?"} ${size} from ${chosen.host}`);
  return chosen.url;
}

function extensionFor(contentType: string | null, url: string): string {
  const fromUrl = /\.(mp3|m4a|wav|aac|ogg|flac|mp4)(\?|$)/i.exec(url)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  if (!contentType) return "bin";
  if (contentType.includes("mpeg")) return "mp3";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return "m4a";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("aac")) return "aac";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("flac")) return "flac";
  return "bin";
}

/** Strip query/signature so a URL can be shown or logged without leaking credentials. */
function safeUrl(u: string): string {
  return u.split("?")[0] ?? u;
}

async function main() {
  const args = parseArgs();
  const sourceUrl = args.fromScan ? pickFromScan(args.index) : args.url;

  if (!sourceUrl) {
    console.error('Usage:\n  npm run fetch:audio -- --from-scan [--index N] [--out name.mp3]\n  npm run fetch:audio -- "<media url>" [--out name.mp3]');
    process.exit(1);
  }

  let host: string;
  try {
    host = new URL(sourceUrl).host;
  } catch {
    console.error(`Not a valid URL: ${safeUrl(sourceUrl)}`);
    process.exit(1);
  }

  if (!isAllowedHost(host) && !args.allowAnyHost) {
    console.error(`Refusing to download from ${host}: not in PLAUD_ALLOWED_HOSTS.`);
    console.error("Plaud often serves media from a CDN or storage host. If that host looks right, either:");
    console.error(`  - add it:   PLAUD_ALLOWED_HOSTS=web.plaud.ai,api.plaud.ai,${host}`);
    console.error("  - or pass:  --allow-host   (this one time)");
    process.exit(1);
  }

  console.log(`\nDownloading from ${host}…`);

  const res = await fetch(sourceUrl, {
    headers: { Accept: "*/*" },
    signal: AbortSignal.timeout(Math.max(config.requestTimeoutMs, 300_000)),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status} from ${host}.`);
    if (res.status === 403 || res.status === 401) {
      console.error("Signed media links expire, usually within hours. Re-record the HAR and scan it again.");
    }
    process.exit(1);
  }

  const contentType = res.headers.get("content-type");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (contentType && !/^(audio|video|application\/octet-stream)/i.test(contentType)) {
    console.error(`That URL returned ${contentType}, which is not audio. Wrong URL?`);
    process.exit(1);
  }
  if (!res.body) {
    console.error("Empty response body.");
    process.exit(1);
  }

  const dir = join(config.dataDir, "shares");
  mkdirSync(dir, { recursive: true });
  const name = args.out ?? `plaud-share-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(contentType, sourceUrl)}`;
  const outPath = join(dir, name);

  // Stream to disk while hashing, so a long recording never sits in memory.
  const hash = createHash("sha256");
  let bytes = 0;
  let lastLogged = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
    if (bytes - lastLogged > 5_000_000) {
      lastLogged = bytes;
      const pct = declared ? ` (${Math.round((bytes / declared) * 100)}%)` : "";
      process.stdout.write(`\r  ${(bytes / 1_048_576).toFixed(1)} MB${pct}`);
    }
  });

  try {
    await pipeline(source, createWriteStream(outPath));
  } catch (e) {
    // Never leave a half-written file looking like a good download.
    await rm(outPath, { force: true });
    console.error(`\nDownload failed: ${String((e as Error).message ?? e)}`);
    process.exit(1);
  }

  const written = await stat(outPath);
  if (declared && written.size !== declared) {
    await rm(outPath, { force: true });
    console.error(`\nTruncated download: expected ${declared} bytes, got ${written.size}. Deleted the partial file; try again.`);
    process.exit(1);
  }

  const manifest: Manifest = {
    fetchedAt: new Date().toISOString(),
    sourceUrl,
    sourceHost: host,
    contentType,
    bytes: written.size,
    sha256: hash.digest("hex"),
    file: outPath,
  };
  writeFileSync(`${outPath}.json`, JSON.stringify(manifest, null, 2));

  process.stdout.write("\r");
  console.log(`\nSaved  ${outPath}`);
  console.log(`Size   ${(written.size / 1_048_576).toFixed(1)} MB`);
  console.log(`SHA256 ${manifest.sha256}`);
  console.log(`\nThat file is yours to import into Plaud by hand today (Plaud Web > import audio),`);
  console.log(`and it is the exact file the automated import will use once that path is proven.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
