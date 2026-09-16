import { readManifest } from "./archive.js";
import { humanDuration } from "./format.js";
import { importArchive } from "./importer.js";
import { UploadError, utcOffsetHours } from "./uploadClient.js";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Upload a local audio file into your own Plaud workspace.
 *
 *   npm run import:audio -- --from-share data/shares/<folder>
 *   npm run import:audio -- data/shares/<folder>/audio.mp3
 *   npm run import:audio -- <file> --title "Weekly sync" --start-time 2026-09-14T16:18:00Z
 *   npm run import:audio -- --from-share <folder> --extra-copy   # import it again anyway
 *   npm run import:audio -- <file> --dry-run
 *
 * With --from-share, the title and the ORIGINAL recording date come from the
 * archive's manifest, so the imported recording is dated when the meeting
 * happened rather than when it was uploaded.
 *
 * Needs credentials in .env — see docs/UPLOAD-API.md. The upload itself lives in
 * src/importer.ts; this is the command-line face of it.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Values that follow a flag must not be mistaken for the positional file path. */
function isOptionValue(value: string): boolean {
  const i = process.argv.indexOf(value);
  const prev = i > 0 ? process.argv[i - 1] : undefined;
  return prev === "--title" || prev === "--start-time" || prev === "--from-share" || prev === "--session-id";
}

function resolveInput(): { audioPath: string; title: string; startTime: number; shareDir?: string } {
  const shareDir = arg("--from-share");
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== shareDir && !isOptionValue(a));

  if (shareDir) {
    const manifest = readManifest(shareDir);
    if (!manifest) {
      console.error(`No readable manifest.json in ${shareDir}.`);
      console.error("Point --from-share at a folder created by:  npm run fetch:share");
      process.exit(1);
    }
    const audioPath = join(shareDir, manifest.audio?.file ?? "audio.mp3");
    if (!existsSync(audioPath)) {
      console.error(`That archive has no audio at ${audioPath}.`);
      process.exit(1);
    }
    return {
      audioPath,
      title: arg("--title") ?? manifest.title ?? basename(shareDir),
      startTime: arg("--start-time")
        ? Date.parse(arg("--start-time")!)
        : manifest.recordedAt
          ? Date.parse(manifest.recordedAt)
          : Date.now(),
      shareDir,
    };
  }

  if (!positional) {
    console.error(
      'Usage:\n' +
        '  npm run import:audio -- <file.mp3> [--title "..."] [--start-time <ISO>] [--dry-run]\n' +
        "  npm run import:audio -- --from-share data/shares/<folder> [--extra-copy]",
    );
    process.exit(1);
  }
  if (!existsSync(positional)) {
    console.error(`No such file: ${positional}`);
    process.exit(1);
  }
  return {
    audioPath: positional,
    title: arg("--title") ?? basename(positional).replace(/\.[a-z0-9]+$/i, ""),
    startTime: arg("--start-time") ? Date.parse(arg("--start-time")!) : statSync(positional).mtimeMs,
  };
}

async function main() {
  const { audioPath, title, startTime, shareDir } = resolveInput();
  const dryRun = process.argv.includes("--dry-run");
  // --force is accepted as a synonym because that is what people reach for.
  const extraCopy = process.argv.includes("--extra-copy") || process.argv.includes("--force");
  const sessionId = Number(arg("--session-id") ?? 0);

  if (!Number.isFinite(startTime)) {
    console.error("--start-time must be an ISO date, e.g. 2026-09-14T16:18:00Z");
    process.exit(1);
  }
  if (!Number.isInteger(sessionId)) {
    console.error("--session-id must be a whole number.");
    process.exit(1);
  }

  const offset = utcOffsetHours();
  console.log(`\nImporting into your Plaud Personal workspace\n`);
  console.log(`  File     ${audioPath}`);
  console.log(`  Size     ${(statSync(audioPath).size / 1_048_576).toFixed(1)} MB`);
  console.log(`  Title    ${title}`);
  console.log(`  Dated    ${new Date(startTime).toISOString().replace("T", " ").slice(0, 16)} (UTC${offset >= 0 ? "+" : ""}${offset})`);

  if (dryRun) {
    console.log("\nDry run — nothing was uploaded.");
    return;
  }

  try {
    const result = await importArchive({
      audioPath,
      title,
      startTime,
      shareDir,
      extraCopy,
      sessionId,
      log: (line) => console.log(line),
    });

    if (result.status === "already-imported") {
      const manifest = shareDir ? readManifest(shareDir) : null;
      console.log(`\nAlready imported${manifest?.importedAt ? ` on ${manifest.importedAt.slice(0, 10)}` : ""}.`);
      console.log(`  Plaud file id: ${result.fileIdPrefixed}`);
      console.log("\nNothing uploaded. To deliberately add a second copy:");
      console.log(`  npm run import:audio -- --from-share ${shareDir} --extra-copy`);
      return;
    }

    console.log(`\n  Imported. Plaud file id: ${result.fileIdPrefixed ?? "(not returned)"}`);
    if (result.checksumMatched === true) console.log("  Checksum matches Plaud's copy");
    if (result.checksumMatched === false) console.log("  WARNING: checksum DIFFERS from Plaud's copy");

    const manifest = shareDir ? readManifest(shareDir) : null;
    if (manifest?.durationMs) console.log(`  Expect a ${humanDuration(manifest.durationMs)} recording in Plaud.`);

    console.log(`\nPlaud imports audio only. To get a transcript there, ask Plaud to`);
    console.log(`transcribe it; your original from the share stays in the archive.`);
  } catch (e) {
    if (e instanceof UploadError) {
      console.error(`\n${e.message}`);
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
