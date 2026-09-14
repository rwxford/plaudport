import { config } from "./config.js";
import { DownloadError, downloadToFile } from "./download.js";
import { detailToMarkdown, humanDuration, slugify, transcriptToText } from "./format.js";
import { fetchShareAudioUrl, fetchShareDetail, ShareApiError, type ShareDetail } from "./shareClient.js";
import { describeShare, parseShareUrl, ShareUrlError, type ShareRef } from "./shareUrl.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Archive a shared Plaud recording locally — audio, transcript, outline, notes.
 *
 *   npm run fetch:share -- "https://web.plaud.ai/s/pub_...::token"
 *
 * Needs no Plaud account: a share link is its own authorisation. Everything
 * lands under data/shares/<shareId>/ ready to import into Plaud by hand, and
 * ready for the automated import once that path is proven.
 *
 * Re-running is safe: if the audio is already archived and its checksum matches,
 * it is not downloaded again.
 */

interface Manifest {
  shareId: string;
  fetchedAt: string;
  title: string;
  recordedAt: string | null;
  durationMs: number | null;
  language: string | null;
  audio: { file: string; bytes: number; sha256: string; contentType: string | null } | null;
  counts: { utterances: number; polishedUtterances: number; outlineTopics: number; notes: number };
  files: string[];
}

function writeIfPresent(dir: string, name: string, content: string, files: string[]) {
  if (!content.trim()) return;
  writeFileSync(join(dir, name), content);
  files.push(name);
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");
  if (!arg) {
    console.error('Usage: npm run fetch:share -- "<share url>" [--force]');
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

  console.log(`\nFetching share ${describeShare(ref)}\n`);

  // --- 1. metadata + transcript (one unauthenticated call) ---
  let detail: ShareDetail;
  try {
    detail = await fetchShareDetail(ref);
  } catch (e) {
    if (e instanceof ShareApiError) {
      console.error(e.message);
      if (e.hint) console.error(e.hint);
      process.exit(1);
    }
    throw e;
  }

  const f = detail.data_file ?? {};
  const title = f.filename?.trim() || "Untitled recording";
  const counts = {
    utterances: f.trans_result?.length ?? 0,
    polishedUtterances: f.transaction_polish?.length ?? 0,
    outlineTopics: f.outline_result?.length ?? 0,
    notes: f.notes_list?.length ?? 0,
  };

  console.log(`  Title      ${title}`);
  console.log(`  Recorded   ${f.start_time ? new Date(f.start_time).toISOString().replace("T", " ").slice(0, 16) : "unknown"}`);
  console.log(`  Length     ${humanDuration(f.duration)}`);
  console.log(`  Transcript ${counts.utterances} utterances${counts.polishedUtterances ? ` (+${counts.polishedUtterances} polished)` : ""}`);
  console.log(`  Outline    ${counts.outlineTopics} topics`);
  console.log(`  Notes      ${counts.notes}`);
  if (!detail.is_audio) console.log("  NOTE: this share reports no audio.");

  const dir = join(config.dataDir, "shares", `${ref.shareId}-${slugify(title)}`);
  mkdirSync(dir, { recursive: true });

  // --- 2. write the text side ---
  const files: string[] = [];
  writeFileSync(join(dir, "detail.json"), JSON.stringify(detail, null, 2));
  files.push("detail.json");
  writeIfPresent(dir, "transcript.txt", transcriptToText(f.trans_result), files);
  writeIfPresent(dir, "transcript-polished.txt", transcriptToText(f.transaction_polish), files);
  writeIfPresent(dir, "recording.md", detailToMarkdown(detail, ref.shareId), files);

  // --- 3. audio ---
  let audio: Manifest["audio"] = null;
  const audioPath = join(dir, "audio.mp3");
  const manifestPath = join(dir, "manifest.json");

  const previous: Manifest | null = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
    : null;

  if (!force && previous?.audio && existsSync(audioPath)) {
    const onDisk = createHash("sha256").update(readFileSync(audioPath)).digest("hex");
    if (onDisk === previous.audio.sha256) {
      console.log("\n  Audio already archived and verified — skipping download (use --force to redo).");
      audio = previous.audio;
    }
  }

  if (!audio && detail.is_audio) {
    try {
      console.log("\n  Requesting audio link…");
      const tempUrl = await fetchShareAudioUrl(ref);
      let lastPct = -1;
      const result = await downloadToFile(tempUrl, audioPath, {
        expectMediaType: true,
        onProgress: (bytes, total) => {
          const pct = total ? Math.floor((bytes / total) * 100) : -1;
          if (pct >= 0 && pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  Downloading… ${pct}%`);
          }
        },
      });
      process.stdout.write("\r");
      audio = { file: "audio.mp3", ...result };
      console.log(`  Audio      ${(result.bytes / 1_048_576).toFixed(1)} MB  sha256 ${result.sha256.slice(0, 16)}…`);
      files.push("audio.mp3");
    } catch (e) {
      if (e instanceof DownloadError || e instanceof ShareApiError) {
        console.error(`\n  Audio download failed: ${e.message}`);
        if (e.hint) console.error(`  ${e.hint}`);
        console.error("  The transcript and notes above were still saved.");
      } else {
        throw e;
      }
    }
  }

  const manifest: Manifest = {
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
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nSaved to ${dir}`);
  for (const name of [...files, "manifest.json"]) console.log(`  ${name}`);

  if (audio) {
    console.log(`\nNext: import the audio into Plaud by hand — Plaud Web > your Personal`);
    console.log(`workspace > import audio, then pick:`);
    console.log(`  ${join(dir, "audio.mp3")}`);
    console.log(`\nThe original transcript is preserved in transcript.txt and recording.md,`);
    console.log(`so nothing is lost if Plaud re-transcribes its copy.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
