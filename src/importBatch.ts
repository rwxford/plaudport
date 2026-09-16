import { archiveShare } from "./archive.js";
import { config } from "./config.js";
import { humanDuration } from "./format.js";
import { importArchive } from "./importer.js";
import { parseLinkList } from "./linkList.js";
import { ShareApiError } from "./shareClient.js";
import { parseShareUrl, ShareUrlError } from "./shareUrl.js";
import { assertTokenUsable, UploadError } from "./uploadClient.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Archive and import share links — one, several, or a file of them.
 *
 *   npm run import -- "https://web.plaud.ai/s/pub_…::tok"
 *   npm run import -- links.txt
 *   npm run import -- links.txt "https://…" "https://…"     # any mix
 *   npm run import -- links.txt --fetch-only                # archive, don't upload
 *   npm run import -- links.txt --extra-copy                # re-import ones already done
 *
 * One link and a hundred take the same command: there is no reason to remember
 * two. A file argument is read as a list, one link per line, with blank lines
 * and #-comments ignored so it can be kept as a working file.
 *
 * One bad link must not sink the run: each is tried, failures are recorded, and
 * the summary at the end says exactly which ones need attention. The credential
 * is checked ONCE up front, because discovering an expired token on link 9 of 12
 * after uploading eight files is the worst possible time to find out.
 */

interface Outcome {
  url: string;
  shareId?: string;
  title?: string;
  status: "imported" | "already-imported" | "archived" | "failed";
  fileId?: string;
  detail?: string;
}

/** A bare argument is either a link to import or a file listing links. */
function looksLikeLink(arg: string): boolean {
  return /^https?:\/\//i.test(arg) || arg.includes("::");
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const fetchOnly = process.argv.includes("--fetch-only");
  const extraCopy = process.argv.includes("--extra-copy") || process.argv.includes("--force");

  if (args.length === 0) {
    console.error("Usage:");
    console.error('  npm run import -- "<share link>"          one link');
    console.error("  npm run import -- <links.txt>             a file of links, one per line");
    console.error('  npm run import -- <links.txt> "<link>"    any mix of the two');
    console.error("\nOptions: --fetch-only (archive without uploading), --extra-copy (import again)");
    process.exit(1);
  }

  const links: string[] = [];
  const sources: string[] = [];
  for (const arg of args) {
    if (looksLikeLink(arg)) {
      links.push(arg);
      continue;
    }
    if (!existsSync(arg)) {
      console.error(`Not a share link, and no such file: ${arg}`);
      process.exit(1);
    }
    const fromFile = parseLinkList(readFileSync(arg, "utf8"));
    if (fromFile.length === 0) {
      console.error(`${arg} has no links in it.`);
      process.exit(1);
    }
    links.push(...fromFile);
    sources.push(arg);
  }

  console.log(`\n${links.length} link${links.length === 1 ? "" : "s"}${sources.length ? ` from ${sources.join(", ")}` : ""}`);
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

  for (const [i, url] of links.entries()) {
    const position = links.length > 1 ? `[${i + 1}/${links.length}]` : "";
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

  if (links.length > 1) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Imported ${counts.imported}   Already there ${counts.already}   Archived only ${counts.archived}   Failed ${counts.failed}`);
  }

  if (counts.failed) {
    console.log("\nNeeds attention:");
    for (const o of outcomes.filter((x) => x.status === "failed")) {
      console.log(`  ${o.shareId ?? o.url.slice(0, 60)} — ${o.detail}`);
    }
  }

  if (links.length > 1) {
    const runsDir = join(config.dataDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const reportPath = join(runsDir, `batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify({ startedFrom: sources, fetchOnly, outcomes }, null, 2));
    console.log(`\nRun report: ${reportPath}`);
  }

  // Non-zero exit when something needs a human, so this can be scripted.
  if (counts.failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
