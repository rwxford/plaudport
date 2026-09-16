import { archiveShare } from "./archive.js";
import { humanDuration } from "./format.js";
import { ShareApiError } from "./shareClient.js";
import { describeShare, parseShareUrl, ShareUrlError, type ShareRef } from "./shareUrl.js";
import { join } from "node:path";

/**
 * Archive a shared Plaud recording locally — audio, transcript, outline, notes.
 *
 *   npm run fetch:share -- "https://web.plaud.ai/s/pub_...::token"
 *
 * Needs no Plaud account: a share link is its own authorisation. Everything
 * lands under data/shares/<shareId>-<slug>/.
 *
 * Re-running is safe: if the audio is already archived and its checksum matches,
 * it is not downloaded again. --force re-downloads.
 *
 * The work itself lives in src/archive.ts; this is the command-line face of it.
 */
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

  try {
    const { dir, manifest, audioError } = await archiveShare(ref, { force, log: (l) => console.log(l) });

    console.log(`\n  Title      ${manifest.title}`);
    console.log(`  Recorded   ${manifest.recordedAt?.replace("T", " ").slice(0, 16) ?? "unknown"}`);
    console.log(`  Length     ${humanDuration(manifest.durationMs ?? undefined)}`);
    console.log(
      `  Transcript ${manifest.counts.utterances} utterances` +
        (manifest.counts.polishedUtterances ? ` (+${manifest.counts.polishedUtterances} polished)` : ""),
    );
    console.log(`  Outline    ${manifest.counts.outlineTopics} topics`);
    console.log(`  Notes      ${manifest.counts.notes}`);
    if (manifest.audio) {
      console.log(`  Audio      ${(manifest.audio.bytes / 1_048_576).toFixed(1)} MB  sha256 ${manifest.audio.sha256.slice(0, 16)}…`);
    }

    if (audioError) {
      console.error(`\n  Audio download failed: ${audioError}`);
      console.error("  The transcript and notes were still saved.");
    }

    console.log(`\nSaved to ${dir}`);
    for (const name of [...manifest.files, "manifest.json"]) console.log(`  ${name}`);

    if (manifest.audio) {
      console.log(`\nNext: import it into your Plaud workspace:`);
      console.log(`  npm run import:audio -- --from-share ${dir}`);
      console.log(`\nOr by hand, from ${join(dir, "audio.mp3")}.`);
      console.log(`Either way the original transcript stays here — Plaud will not import it.`);
    }
  } catch (e) {
    if (e instanceof ShareApiError) {
      console.error(e.message);
      if (e.hint) console.error(e.hint);
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
