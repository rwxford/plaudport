import { config } from "./config.js";
import { slugify } from "./format.js";
import type { ImportRecord, Logger } from "./archive.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * Importing a recording that is already on disk — a Gong download today, any
 * audio or video file in general.
 *
 * Plaud's upload is proven for MP3 only (docs/UPLOAD-API.md), so anything else
 * is converted with ffmpeg first. Gong hands out MP4 (video) or WAV (audio),
 * which covers the common case. An hour of CD-quality WAV is also ~600 MB that
 * nobody wants to upload when under 80 MB of MP3 carries the same speech.
 *
 * Each file is archived under data/imports/<sha256-prefix>-<title>/, keyed by
 * the checksum of the ORIGINAL file, so importing the same download twice — or
 * a renamed copy of it — is recognised and skipped.
 */

/** Extensions read as a recording rather than as a list of links. */
export const MEDIA_EXTENSIONS = new Set([
  ".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv",
]);

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

export class MediaError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "MediaError";
  }
}

/**
 * Read a recording date as a person would type it.
 *
 *   2026-09-20              local midnight that day
 *   2026-09-20 14:30        local time (a "T" instead of the space works too)
 *   2026-09-20T14:30:00Z    an exact instant, when a zone is given
 *
 * A bare date is deliberately NOT handed to Date.parse, which reads it as UTC
 * midnight — the previous evening anywhere in the Americas, so a call on the
 * 20th would land in Plaud on the 19th.
 */
export function parseWhen(text: string): number {
  const s = text.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (local) {
    const [y, mo, d, h = "0", mi = "0", sec = "0"] = local.slice(1);
    const date = new Date(+y!, +mo! - 1, +d!, +h, +mi, +sec);
    // Date quietly rolls 2026-02-31 over into March; refuse instead.
    if (date.getMonth() !== +mo! - 1 || date.getDate() !== +d! || +h > 23 || +mi > 59) {
      throw new MediaError(`Not a real date: ${text}`);
    }
    return date.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }
  throw new MediaError(
    `Could not read the date "${text}".`,
    'Use 2026-09-20, or 2026-09-20 14:30 for a time (24-hour, your local time).',
  );
}

export interface MediaProbe {
  durationMs: number | null;
  /** The container's own creation_time tag, if it has a plausible one. */
  createdAt: number | null;
}

/** Duration and embedded date via ffprobe. Null when ffprobe is not installed. */
export function probeMedia(path: string): MediaProbe | null {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:format_tags=creation_time", "-of", "json", path],
    { encoding: "utf8" },
  );
  if (r.error || r.status !== 0) return null;
  try {
    const format = (JSON.parse(r.stdout) as { format?: { duration?: string; tags?: { creation_time?: string } } }).format;
    const duration = Number(format?.duration);
    const created = format?.tags?.creation_time ? Date.parse(format.tags.creation_time) : NaN;
    return {
      durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
      // Encoders write 1970 or 1904 when they have nothing better; that is not a date.
      createdAt: Number.isFinite(created) && created > Date.UTC(2000, 0, 1) ? created : null,
    };
  } catch {
    return null;
  }
}

/** Extract the first audio track to MP3. Writes to a temp name and renames, so
 *  an interrupted conversion never leaves a plausible-looking audio.mp3. */
export function convertToMp3(src: string, dest: string): void {
  const partial = `${dest}.partial`;
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", src,
      "-map", "0:a:0", "-vn", "-map_metadata", "-1",
      // VBR ~165 kbps: transparent for speech, a fraction of a WAV's size.
      "-c:a", "libmp3lame", "-q:a", "4",
      "-f", "mp3", partial,
    ],
    { encoding: "utf8" },
  );
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new MediaError(
      `Converting ${extname(src)} to MP3 needs ffmpeg, which isn't installed.`,
      "Install it with:  brew install ffmpeg",
    );
  }
  if (r.status !== 0) {
    rmSync(partial, { force: true });
    const stderr = (r.stderr || String(r.error ?? "")).trim();
    if (/Stream map '0:a:0' matches no streams/.test(stderr)) {
      throw new MediaError(`${basename(src)} has no audio track, so there is nothing to import.`);
    }
    // ffmpeg's last line is usually a generic "Error opening output files"; the
    // first says what actually went wrong.
    const why = stderr.split("\n")[0] ?? "";
    throw new MediaError(`ffmpeg could not convert ${basename(src)}${why ? `: ${why}` : ""}`);
  }
  renameSync(partial, dest);
}

export type DateSource = "--date" | "file metadata" | "file modified time";

export interface LocalManifest extends ImportRecord {
  kind: "local-file";
  source: { name: string; bytes: number; sha256: string };
  archivedAt: string;
  title: string;
  recordedAt: string;
  dateFrom: DateSource;
  durationMs: number | null;
  audio: { file: string; bytes: number; sha256: string; convertedFrom: string | null };
}

export interface LocalArchiveResult {
  dir: string;
  manifest: LocalManifest;
  /** True when the date is only a guess from the file's timestamp. */
  dateIsGuess: boolean;
  audioReused: boolean;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The archive folder is named by checksum prefix first, so it can be found
 *  again whatever the file or the recording has since been called. */
export function localArchiveDirName(sha256: string, title: string): string {
  return `${sha256.slice(0, 12)}-${slugify(title)}`;
}

function findExisting(root: string, sha256: string): string | null {
  if (!existsSync(root)) return null;
  const prefix = `${sha256.slice(0, 12)}-`;
  const hit = readdirSync(root).find((name) => name.startsWith(prefix));
  return hit ? join(root, hit) : null;
}

function readLocalManifest(dir: string): LocalManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as LocalManifest;
  } catch {
    return null;
  }
}

export function archiveLocalMedia(
  path: string,
  opts: { title?: string; when?: number; log?: Logger } = {},
): LocalArchiveResult {
  const log = opts.log ?? (() => {});
  if (!existsSync(path)) throw new MediaError(`No such file: ${path}`);

  const bytes = statSync(path).size;
  const sha256 = sha256File(path);
  const root = join(config.dataDir, "imports");
  const previous = (() => {
    const dir = findExisting(root, sha256);
    return dir ? { dir, manifest: readLocalManifest(dir) } : null;
  })();
  const prior = previous?.manifest ?? null;
  // Once a recording is in Plaud, renaming it here would only make the archive
  // disagree with Plaud; the flags apply to recordings not yet imported.
  const locked = Boolean(prior?.importedFileId);

  const ext = extname(path).toLowerCase();
  const probe = probeMedia(path);

  const title =
    (!locked && opts.title?.trim()) || prior?.title || basename(path, extname(path)).trim() || "Imported recording";

  let recordedAt: number;
  let dateFrom: DateSource;
  if (!locked && opts.when !== undefined) {
    [recordedAt, dateFrom] = [opts.when, "--date"];
  } else if (prior?.recordedAt && (locked || prior.dateFrom === "--date")) {
    [recordedAt, dateFrom] = [Date.parse(prior.recordedAt), prior.dateFrom];
  } else if (probe?.createdAt) {
    [recordedAt, dateFrom] = [probe.createdAt, "file metadata"];
  } else {
    [recordedAt, dateFrom] = [statSync(path).mtimeMs, "file modified time"];
  }

  const dir = previous?.dir ?? join(root, localArchiveDirName(sha256, title));
  mkdirSync(dir, { recursive: true });
  const audioPath = join(dir, "audio.mp3");

  let audio: LocalManifest["audio"] | null = null;
  let audioReused = false;
  if (prior?.audio && existsSync(audioPath) && sha256File(audioPath) === prior.audio.sha256) {
    audio = prior.audio;
    audioReused = true;
    log("  Already archived and verified — not converting again.");
  } else {
    if (ext === ".mp3") {
      copyFileSync(path, audioPath);
    } else {
      log(`  Converting ${ext.slice(1).toUpperCase()} to MP3…`);
      convertToMp3(path, audioPath);
    }
    audio = {
      file: "audio.mp3",
      bytes: statSync(audioPath).size,
      sha256: sha256File(audioPath),
      convertedFrom: ext === ".mp3" ? null : ext.slice(1),
    };
  }

  const manifest: LocalManifest = {
    ...(prior ?? {}),
    kind: "local-file",
    source: { name: basename(path), bytes, sha256 },
    archivedAt: prior?.archivedAt ?? new Date().toISOString(),
    title,
    recordedAt: new Date(recordedAt).toISOString(),
    dateFrom,
    durationMs: probeMedia(audioPath)?.durationMs ?? probe?.durationMs ?? prior?.durationMs ?? null,
    audio,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return { dir, manifest, dateIsGuess: dateFrom === "file modified time", audioReused };
}
