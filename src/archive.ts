import { config } from "./config.js";
import { DownloadError, downloadToFile } from "./download.js";
import { detailToMarkdown, slugify, transcriptToText } from "./format.js";
import { fetchShareAudioUrl, fetchShareDetail, ShareApiError, type ShareDetail } from "./shareClient.js";
import type { ShareRef } from "./shareUrl.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Archiving a shared recording, as a function rather than a script — so one
 * link, a batch of links, and (later) a local web page can all use the same
 * code path instead of drifting apart.
 */

export interface ShareManifest {
  shareId: string;
  fetchedAt: string;
  title: string;
  recordedAt: string | null;
  durationMs: number | null;
  language: string | null;
  audio: { file: string; bytes: number; sha256: string; contentType: string | null } | null;
  counts: { utterances: number; polishedUtterances: number; outlineTopics: number; notes: number };
  files: string[];
  importedFileId?: string;
  /** The same id with the `of_` prefix Plaud's own APIs and MCP use. */
  importedFileIdPrefixed?: string;
  importedAt?: string;
}

export interface ArchiveResult {
  dir: string;
  manifest: ShareManifest;
  /** Set when the audio could not be fetched; the text side is still archived. */
  audioError?: string;
  audioReused: boolean;
}

export type Logger = (line: string) => void;
const noop: Logger = () => {};

export function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

export function readManifest(dir: string): ShareManifest | null {
  const path = manifestPath(dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ShareManifest;
  } catch {
    return null;
  }
}

function writeIfPresent(dir: string, name: string, content: string, files: string[]) {
  if (!content.trim()) return;
  writeFileSync(join(dir, name), content);
  files.push(name);
}

/**
 * Fetch a share's metadata, transcripts and audio into `data/shares/<id>-<slug>/`.
 * Re-running verifies existing audio by checksum and skips the download.
 * A failed audio download is reported, not thrown: the transcript is still worth
 * keeping, and a share may legitimately have no audio.
 */
export async function archiveShare(ref: ShareRef, opts: { force?: boolean; log?: Logger } = {}): Promise<ArchiveResult> {
  const log = opts.log ?? noop;

  const detail: ShareDetail = await fetchShareDetail(ref);
  const f = detail.data_file ?? {};
  const title = f.filename?.trim() || "Untitled recording";
  const counts = {
    utterances: f.trans_result?.length ?? 0,
    polishedUtterances: f.transaction_polish?.length ?? 0,
    outlineTopics: f.outline_result?.length ?? 0,
    notes: f.notes_list?.length ?? 0,
  };

  const dir = join(config.dataDir, "shares", `${ref.shareId}-${slugify(title)}`);
  mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  writeFileSync(join(dir, "detail.json"), JSON.stringify(detail, null, 2));
  files.push("detail.json");
  writeIfPresent(dir, "transcript.txt", transcriptToText(f.trans_result), files);
  writeIfPresent(dir, "transcript-polished.txt", transcriptToText(f.transaction_polish), files);
  writeIfPresent(dir, "recording.md", detailToMarkdown(detail, ref.shareId), files);

  const audioPath = join(dir, "audio.mp3");
  const previous = readManifest(dir);
  let audio: ShareManifest["audio"] = null;
  let audioReused = false;
  let audioError: string | undefined;

  if (!opts.force && previous?.audio && existsSync(audioPath)) {
    const onDisk = createHash("sha256").update(readFileSync(audioPath)).digest("hex");
    if (onDisk === previous.audio.sha256) {
      audio = previous.audio;
      audioReused = true;
      log("  Audio already archived and verified — skipping download.");
    }
  }

  if (!audio && detail.is_audio) {
    try {
      log("  Requesting audio link…");
      const tempUrl = await fetchShareAudioUrl(ref);
      let lastPct = -1;
      const result = await downloadToFile(tempUrl, audioPath, {
        expectMediaType: true,
        onProgress: (bytes, total) => {
          const pct = total ? Math.floor((bytes / total) * 100) : -1;
          if (pct >= 0 && pct !== lastPct && pct % 25 === 0) {
            lastPct = pct;
            log(`  Downloading… ${pct}%`);
          }
        },
      });
      audio = { file: "audio.mp3", ...result };
      files.push("audio.mp3");
    } catch (e) {
      if (e instanceof DownloadError || e instanceof ShareApiError) {
        audioError = e.hint ? `${e.message} — ${e.hint}` : e.message;
      } else {
        throw e;
      }
    }
  }

  const manifest: ShareManifest = {
    // Keep any import record from a previous run: re-fetching must not make the
    // archive forget that this recording is already in Plaud.
    ...(previous ?? {}),
    shareId: ref.shareId,
    fetchedAt: new Date().toISOString(),
    title,
    recordedAt: f.start_time ? new Date(f.start_time).toISOString() : null,
    durationMs: f.duration ?? null,
    language: f.file_language ?? null,
    audio,
    counts,
    files,
  };
  writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));

  return { dir, manifest, audioError, audioReused };
}
