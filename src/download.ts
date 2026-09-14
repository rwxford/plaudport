import { config, isAllowedHost } from "./config.js";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Streaming download with integrity checking. Shared by fetch:audio and fetch:share. */

export interface DownloadResult {
  bytes: number;
  sha256: string;
  contentType: string | null;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Strip query/signature so a URL can be shown or logged without leaking credentials. */
export function safeUrl(u: string): string {
  return u.split("?")[0] ?? u;
}

/**
 * Stream `url` to `outPath`, hashing as it goes so a long recording never sits in
 * memory. Verifies the byte count against content-length and removes partial
 * files rather than leaving something that looks like a good download.
 */
export async function downloadToFile(
  url: string,
  outPath: string,
  opts: { allowAnyHost?: boolean; expectMediaType?: boolean; onProgress?: (bytes: number, total: number) => void } = {},
): Promise<DownloadResult> {
  const host = new URL(url).host;
  if (!isAllowedHost(host) && !opts.allowAnyHost) {
    throw new DownloadError(
      `Refusing to download from ${host}: not in PLAUD_ALLOWED_HOSTS.`,
      `If that host looks right, add it:  PLAUD_ALLOWED_HOSTS=${config.allowedHosts.join(",")},${host}`,
    );
  }

  const res = await fetch(url, {
    headers: { Accept: "*/*" },
    // Big files over slow links: a 30s timeout is not enough.
    signal: AbortSignal.timeout(Math.max(config.requestTimeoutMs, 600_000)),
  });

  if (!res.ok) {
    throw new DownloadError(
      `HTTP ${res.status} from ${host}`,
      res.status === 403 || res.status === 401
        ? "Signed media links expire, usually within hours. Fetch a fresh one and retry."
        : undefined,
    );
  }

  const contentType = res.headers.get("content-type");
  if (opts.expectMediaType && contentType && !/^(audio|video|binary|application\/octet-stream)/i.test(contentType)) {
    throw new DownloadError(`That URL returned ${contentType}, which is not audio.`);
  }
  if (!res.body) throw new DownloadError("Empty response body.");

  const declared = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  let bytes = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
    opts.onProgress?.(bytes, declared);
  });

  try {
    await pipeline(source, createWriteStream(outPath));
  } catch (e) {
    await rm(outPath, { force: true });
    throw new DownloadError(`Download failed: ${String((e as Error).message ?? e)}`);
  }

  const written = await stat(outPath);
  if (declared && written.size !== declared) {
    await rm(outPath, { force: true });
    throw new DownloadError(
      `Truncated download: expected ${declared} bytes, got ${written.size}. Deleted the partial file.`,
      "Try again — this is usually a dropped connection.",
    );
  }

  return { bytes: written.size, sha256: hash.digest("hex"), contentType };
}
