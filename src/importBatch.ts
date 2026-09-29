import { archiveShare } from "./archive.js";
import { ImportArgsError, parseImportArgs, type ImportArgs } from "./importArgs.js";
import { archiveLocalMedia, MediaError, parseWhen } from "./localMedia.js";
import { config } from "./config.js";
import { humanDuration } from "./format.js";
import { importArchive } from "./importer.js";
import { parseLinkList } from "./linkList.js";
import { ShareApiError } from "./shareClient.js";
import { parseShareUrl, ShareUrlError } from "./shareUrl.js";
import { assertTokenUsable, UploadError } from "./uploadClient.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Archive and import recordings — share links, files on disk, or both.
 *
 *   npm run import -- "https://web.plaud.ai/s/pub_…::tok"
 *   npm run import -- links.txt
 *   npm run import -- links.txt "https://…" "https://…"     # any mix
 *   npm run import -- ~/Downloads/call.mp4 --title "Acme discovery" --date "2026-09-20 14:00"
 *   npm run import -- ~/Downloads/*.mp4                     # several downloads
 *   npm run import -- links.txt --fetch-only                # archive, don't upload
 *   npm run import -- links.txt --extra-copy                # re-import ones already done
 *
 * One recording and a hundred take the same command: there is no reason to
 * remember two. A text file is read as a list, one link per line, with blank
 * lines and #-comments ignored so it can be kept as a working file. An audio or
 * video file (a Gong download, say) is converted to MP3 if need be and imported.
 *
 * One bad link must not sink the run: each is tried, failures are recorded, and
 * the summary at the end says exactly which ones need attention. The credential
 * is checked ONCE up front, because discovering an expired token on link 9 of 12
 * after uploading eight files is the worst possible time to find out.
 */

interface Outcome {
  /** The link or file path, as given. */
  url: string;
  shareId?: string;
  title?: string;
  status: "imported" | "already-imported" | "archived" | "failed";
  fileId?: string;
  detail?: string;
}

function usage(): never {
  console.error("Usage:");
  console.error('  npm run import -- "<share link>"            one link');
  console.error("  npm run import -- <links.txt>               a file of links, one per line");
  console.error("  npm run import -- <recording.mp4|.wav|.mp3> a file on disk, e.g. a Gong download");
  console.error("  …or any mix of the three.");
  console.error("\nOptions:");
  console.error("  --fetch-only             archive locally, upload nothing");
  console.error("  --extra-copy             import again even if already in Plaud");
  console.error('  --title "…"              name for a single file (default: its filename)');
  console.error('  --date "2026-09-20 14:00"  when a single file was recorded, local time');
  process.exit(1);
}

type Item = { kind: "link"; url: string } | { kind: "media"; path: string };

async function main() {
  let opts: ImportArgs;
  try {
    opts = parseImportArgs(process.argv.slice(2), existsSync);
  } catch (e) {
    if (e instanceof ImportArgsError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  if (opts.entries.length === 0) usage();
  const { fetchOnly, extraCopy } = opts;

  let when: number | undefined;
  try {
    when = opts.date === undefined ? undefined : parseWhen(opts.date);
  } catch (e) {
    if (e instanceof MediaError) {
      console.error(e.message);
      if (e.hint) console.error(e.hint);
      process.exit(1);
    }
    throw e;
  }

  const items: Item[] = [];
  const sources: string[] = [];
  for (const entry of opts.entries) {
    if (entry.kind === "link") items.push({ kind: "link", url: entry.value });
    else if (entry.kind === "media") items.push({ kind: "media", path: entry.value });
    else {
      const fromFile = parseLinkList(readFileSync(entry.value, "utf8"));
      if (fromFile.length === 0) {
        console.error(`${entry.value} has no links in it.`);
        process.exit(1);
      }
      items.push(...fromFile.map((url) => ({ kind: "link" as const, url })));
      sources.push(entry.value);
    }
  }

  const n = items.length;
  console.log(`\n${n} recording${n === 1 ? "" : "s"}${sources.length ? ` (links from ${sources.join(", ")})` : ""}`);
  if (fetchOnly) console.log("Fetch only — nothing will be uploaded to Plaud.\n");

  // Fail before any work if the credential is already dead.
  if (!fetchOnly) {
    try {
      assertTokenUsable();
    } catch (e) {
      if (e instanceof UploadError) {
        console.error(`\n${e.message}`);
        if (e.hint) console.error(e.hint);
        console.error("\nRefresh it first:  npm run set:auth");
        process.exit(1);
      }
      throw e;
    }
  }

  const outcomes: Outcome[] = [];

  for (const [i, item] of items.entries()) {
    const position = n > 1 ? `[${i + 1}/${n}]` : "";

    if (item.kind === "media") {
      const outcome = await importLocalFile(item.path, { position, title: opts.title, when, fetchOnly, extraCopy });
      outcomes.push(outcome);
      if (outcome.status === "failed" && /expired/i.test(outcome.detail ?? "")) {
        console.error("\nStopping: the credential expired mid-run. Refresh with `npm run set:auth` and re-run —");
        console.error("recordings already imported will be skipped automatically.");
        break;
      }
      continue;
    }

    const url = item.url;
    let ref;
    try {
      ref = parseShareUrl(url);
    } catch (e) {
      const detail = e instanceof ShareUrlError ? e.message.split("\n")[0]! : String(e);
      console.log(`${position ? `${position} ` : ""}SKIP  not a share link — ${detail}`);
      outcomes.push({ url, status: "failed", detail });
      continue;
    }

    console.log(`\n${position ? `${position} ` : ""}${ref.shareId}`);

    try {
      const { dir, manifest, audioError } = await archiveShare(ref, { log: (l) => console.log(`   ${l.trim()}`) });
      console.log(`   ${manifest.title}`);
      console.log(`   ${humanDuration(manifest.durationMs ?? undefined)}, ${manifest.counts.utterances} utterances`);

      if (audioError) {
        console.log(`   NO AUDIO: ${audioError}`);
        outcomes.push({ url, shareId: ref.shareId, title: manifest.title, status: "archived", detail: audioError });
        continue;
      }
      if (!manifest.audio) {
        console.log("   NO AUDIO: this share has none");
        outcomes.push({ url, shareId: ref.shareId, title: manifest.title, status: "archived", detail: "share has no audio" });
        continue;
      }
      if (fetchOnly) {
        outcomes.push({ url, shareId: ref.shareId, title: manifest.title, status: "archived" });
        continue;
      }

      const result = await importArchive({
        audioPath: join(dir, manifest.audio.file),
        title: manifest.title,
        startTime: manifest.recordedAt ? Date.parse(manifest.recordedAt) : Date.now(),
        shareDir: dir,
        extraCopy,
        log: (l) => console.log(`   ${l.trim()}`),
      });

      if (result.status === "already-imported") {
        console.log(`   Already in Plaud as ${result.fileIdPrefixed} — skipped`);
      } else {
        console.log(`   Imported as ${result.fileIdPrefixed}${result.checksumMatched === false ? " (CHECKSUM MISMATCH)" : ""}`);
      }
      outcomes.push({
        url,
        shareId: ref.shareId,
        title: manifest.title,
        status: result.status,
        fileId: result.fileIdPrefixed,
      });
    } catch (e) {
      const detail = e instanceof ShareApiError || e instanceof UploadError ? e.message.split("\n")[0]! : String(e);
      console.log(`   FAILED: ${detail}`);
      outcomes.push({ url, shareId: ref.shareId, status: "failed", detail });

      // An expired token will fail every remaining link the same way.
      if (e instanceof UploadError && /expired/i.test(e.message)) {
        console.error("\nStopping: the credential expired mid-run. Refresh with `npm run set:auth` and re-run —");
        console.error("links already imported will be skipped automatically.");
        break;
      }
    }
  }

  // --- summary ---
  const counts = {
    imported: outcomes.filter((o) => o.status === "imported").length,
    already: outcomes.filter((o) => o.status === "already-imported").length,
    archived: outcomes.filter((o) => o.status === "archived").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };

  if (n > 1) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Imported ${counts.imported}   Already there ${counts.already}   Archived only ${counts.archived}   Failed ${counts.failed}`);
  }

  if (counts.failed) {
    console.log("\nNeeds attention:");
    for (const o of outcomes.filter((x) => x.status === "failed")) {
      console.log(`  ${o.shareId ?? o.title ?? o.url.slice(0, 60)} — ${o.detail}`);
    }
  }

  if (n > 1) {
    const runsDir = join(config.dataDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const reportPath = join(runsDir, `batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify({ startedFrom: sources, fetchOnly, outcomes }, null, 2));
    console.log(`\nRun report: ${reportPath}`);
  }

  // Non-zero exit when something needs a human, so this can be scripted.
  if (counts.failed) process.exit(1);
}

async function importLocalFile(
  path: string,
  o: { position: string; title?: string; when?: number; fetchOnly: boolean; extraCopy: boolean },
): Promise<Outcome> {
  console.log(`\n${o.position ? `${o.position} ` : ""}${basename(path)}`);
  const log = (l: string) => console.log(`   ${l.trim()}`);
  try {
    const { dir, manifest, dateIsGuess } = archiveLocalMedia(path, { title: o.title, when: o.when, log });
    const dated = new Date(manifest.recordedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    console.log(`   ${manifest.title}`);
    console.log(`   ${humanDuration(manifest.durationMs ?? undefined)}, recorded ${dated} (from ${manifest.dateFrom})`);
    if (dateIsGuess) {
      console.log("   WARNING: that date is only when the file was saved — for a download, that's the day you");
      console.log('   downloaded it, not the day of the call. Pass --date "YYYY-MM-DD HH:MM" to set it.');
    }

    const outcome: Outcome = { url: path, title: manifest.title, status: "archived" };
    if (o.fetchOnly) {
      console.log(`   Archived: ${join(dir, manifest.audio.file)}`);
      return outcome;
    }

    const result = await importArchive({
      audioPath: join(dir, manifest.audio.file),
      title: manifest.title,
      startTime: Date.parse(manifest.recordedAt),
      shareDir: dir,
      extraCopy: o.extraCopy,
      log,
    });
    if (result.status === "already-imported") {
      console.log(`   Already in Plaud as ${result.fileIdPrefixed} — skipped`);
      if (o.title !== undefined || o.when !== undefined) {
        console.log("   (--title/--date not applied: it's already imported. Rename it in Plaud, or use --extra-copy.)");
      }
    } else {
      console.log(`   Imported as ${result.fileIdPrefixed}${result.checksumMatched === false ? " (CHECKSUM MISMATCH)" : ""}`);
    }
    return { ...outcome, status: result.status, fileId: result.fileIdPrefixed };
  } catch (e) {
    const detail =
      e instanceof MediaError || e instanceof UploadError
        ? [e.message.split("\n")[0], e.hint].filter(Boolean).join(" — ")
        : String(e);
    console.log(`   FAILED: ${detail}`);
    return { url: path, title: basename(path), status: "failed", detail };
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
