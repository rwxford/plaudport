import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";

/**
 * Download a presigned audio URL to `<dir>/audio.mp3.part` (P0-PLAN §4):
 * restart from zero, verify length against Content-Length, sha256 on the fly.
 * The URL is a bearer credential: it is never logged or persisted, and errors
 * carry only a status/class.
 */

export class DownloadError extends Error {
  constructor(
    readonly errorClass: string,
    readonly status: number | null = null,
    /** Hostname only (never the URL), for the allowlist hint. */
    readonly host: string | null = null,
  ) {
    super(`audio download failed (${errorClass})`);
  }
}

export interface DownloadOptions {
  isAllowedHost: (host: string) => boolean;
  /** Abort if no bytes arrive for this long (headers or body). */
  idleTimeoutMs: number;
}

export async function downloadToPart(url: string, partPath: string, opts: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DownloadError("bad_url");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"))) {
    throw new DownloadError("insecure_url");
  }
  if (!opts.isAllowedHost(u.host)) throw new DownloadError("host_not_allowed", null, u.hostname);

  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), opts.idleTimeoutMs);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), opts.idleTimeoutMs);
  };
  try {
    let res: Response;
    try {
      res = await fetch(u, { signal: ac.signal, redirect: "error" });
    } catch {
      throw new DownloadError(ac.signal.aborted ? "timeout" : "network");
    }
    if (res.status === 403) throw new DownloadError("http_403", 403);
    if (!res.ok || !res.body) throw new DownloadError(`http_${res.status}`, res.status);
    const expected = Number(res.headers.get("content-length") ?? NaN);

    const hash = createHash("sha256");
    let bytes = 0;
    const out = createWriteStream(partPath, { flags: "w", mode: 0o600 });
    const done = new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        bump();
        hash.update(chunk);
        bytes += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } catch {
      out.destroy();
      throw new DownloadError(ac.signal.aborted ? "timeout" : "stream");
    }
    out.end();
    await done;
    if (Number.isFinite(expected) && expected !== bytes) throw new DownloadError("length_mismatch");
    if (bytes === 0) throw new DownloadError("empty");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    clearTimeout(timer);
  }
}
