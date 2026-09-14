import { config } from "./config.js";
import { DownloadError, downloadToFile, safeUrl } from "./download.js";
import type { MediaRequest } from "./harScan.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

  console.log(`\nDownloading from ${host}…`);

  const dir = join(config.dataDir, "shares");
  mkdirSync(dir, { recursive: true });
  const name = args.out ?? `plaud-share-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(null, sourceUrl)}`;
  const outPath = join(dir, name);

  let result;
  try {
    let lastLogged = 0;
    result = await downloadToFile(sourceUrl, outPath, {
      allowAnyHost: args.allowAnyHost,
      expectMediaType: true,
      onProgress: (bytes, total) => {
        if (bytes - lastLogged > 5_000_000) {
          lastLogged = bytes;
          const pct = total ? ` (${Math.round((bytes / total) * 100)}%)` : "";
          process.stdout.write(`\r  ${(bytes / 1_048_576).toFixed(1)} MB${pct}`);
        }
      },
    });
  } catch (e) {
    if (e instanceof DownloadError) {
      console.error(`\n${e.message}`);
      if (e.hint) console.error(e.hint);
      process.exit(1);
    }
    throw e;
  }

  const manifest: Manifest = {
    fetchedAt: new Date().toISOString(),
    sourceUrl,
    sourceHost: host,
    contentType: result.contentType,
    bytes: result.bytes,
    sha256: result.sha256,
    file: outPath,
  };
  writeFileSync(`${outPath}.json`, JSON.stringify(manifest, null, 2));

  process.stdout.write("\r");
  console.log(`\nSaved  ${outPath}`);
  console.log(`Size   ${(result.bytes / 1_048_576).toFixed(1)} MB`);
  console.log(`SHA256 ${result.sha256}`);
  console.log(`\nThat file is yours to import into Plaud by hand today (Plaud Web > import audio),`);
  console.log(`and it is the exact file the automated import will use once that path is proven.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
