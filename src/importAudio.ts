import { config } from "./config.js";
import { humanDuration } from "./format.js";
import {
  assertTokenUsable,
  confirmUpload,
  mergeParts,
  PART_SIZE,
  planParts,
  requestUpload,
  uploadPart,
  UploadError,
  utcOffsetHours,
  type UploadedPart,
} from "./uploadClient.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Upload a local audio file into your own Plaud workspace.
 *
 *   npm run import:audio -- data/shares/<folder>/audio.mp3
 *   npm run import:audio -- --from-share data/shares/<folder>
 *   npm run import:audio -- <file> --title "Weekly sync" --start-time 2026-09-14T16:18:00Z
 *   npm run import:audio -- <file> --dry-run
 *
 * With --from-share, the title and the ORIGINAL recording date come from the
 * archive's manifest, so the imported recording is dated when the meeting
 * happened rather than when it was uploaded.
 *
 * Needs PLAUD_USER_TOKEN (the x-pld-user header). See docs/UPLOAD-API.md.
 */

interface ShareManifest {
  title?: string;
  recordedAt?: string | null;
  durationMs?: number | null;
  audio?: { file?: string; sha256?: string; bytes?: number } | null;
  importedFileId?: string;
  /** The same id with the `of_` prefix Plaud's own APIs and MCP use. */
  importedFileIdPrefixed?: string;
  importedAt?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function resolveInput(): { audioPath: string; title: string; startTime: number; shareDir?: string } {
  const shareDir = arg("--from-share");
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== shareDir && !isOptionValue(a));

  if (shareDir) {
    const manifestPath = join(shareDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      console.error(`No manifest.json in ${shareDir}.`);
      console.error("Point --from-share at a folder created by:  npm run fetch:share");
      process.exit(1);
    }
    const manifest: ShareManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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
        "  npm run import:audio -- --from-share data/shares/<folder>",
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

/** Values that follow a flag must not be mistaken for the positional file path. */
function isOptionValue(value: string): boolean {
  const i = process.argv.indexOf(value);
  const prev = i > 0 ? process.argv[i - 1] : undefined;
  return prev === "--title" || prev === "--start-time" || prev === "--from-share";
}

async function main() {
  const { audioPath, title, startTime, shareDir } = resolveInput();
  const dryRun = process.argv.includes("--dry-run");

  if (!Number.isFinite(startTime)) {
    console.error("--start-time must be an ISO date, e.g. 2026-09-14T16:18:00Z");
    process.exit(1);
  }

  const bytes = statSync(audioPath).size;
  const partCount = Math.ceil(bytes / PART_SIZE);

  console.log(`\nImporting into your Plaud Personal workspace\n`);
  console.log(`  File     ${audioPath}`);
  console.log(`  Size     ${(bytes / 1_048_576).toFixed(1)} MB  (${partCount} part${partCount === 1 ? "" : "s"})`);
  console.log(`  Title    ${title}`);
  console.log(`  Dated    ${new Date(startTime).toISOString().replace("T", " ").slice(0, 16)} (UTC${utcOffsetHours() >= 0 ? "+" : ""}${utcOffsetHours()})`);

  if (dryRun) {
    console.log("\nDry run — nothing was uploaded.");
    return;
  }

  try {
    assertTokenUsable();

    // confirm_upload's session_id is an integer identifying a recording session
    // on a device. A web import has none, so 0. (/file/welcome returns a
    // UUID-shaped `session_id` — same name, different thing, not this.)
    const sessionId = Number(arg("--session-id") ?? 0);
    if (!Number.isInteger(sessionId)) {
      console.error("--session-id must be a whole number.");
      process.exit(1);
    }

    const target = await requestUpload(bytes);
    if (target.partUrls.length !== partCount) {
      // Plaud decides the part count; trust it over our arithmetic.
      console.log(`  (Plaud asked for ${target.partUrls.length} parts, not ${partCount} — following Plaud.)`);
    }

    const file = readFileSync(audioPath);
    const parts: UploadedPart[] = [];
    const ranges = planParts(file.length, target.partUrls.length);

    if (ranges.length !== target.partUrls.length) {
      throw new UploadError(
        `Plaud asked for ${target.partUrls.length} parts but ${(bytes / 1_048_576).toFixed(1)} MB splits into ${ranges.length} at ${PART_SIZE / 1_048_576} MiB each.`,
        "Plaud's part size has probably changed; PART_SIZE in src/uploadClient.ts needs updating.",
      );
    }

    for (const [i, url] of target.partUrls.entries()) {
      const range = ranges[i]!;
      process.stdout.write(`\r  Uploading part ${range.partNumber} of ${ranges.length}…`);
      parts.push(await uploadPart(url, range.partNumber, file.subarray(range.start, range.end)));
    }
    process.stdout.write("\r");

    await mergeParts(target.uploadId, target.objectName, parts);

    const created = await confirmUpload({
      uploadId: target.uploadId,
      objectName: target.objectName,
      filename: title,
      startTime,
      sessionId,
    });

    console.log(`\n  Imported. Plaud file id: ${created.id ?? "(not returned)"}`);
    if (created.id) console.log(`  Look it up as: of_${created.id}  (Plaud's APIs and MCP prefix file ids)`);
    if (created.filesize && created.filesize !== bytes) {
      console.log(`  NOTE: Plaud recorded ${created.filesize} bytes, we sent ${bytes}.`);
    }

    // Local integrity check against what Plaud stored.
    if (created.file_md5) {
      const localMd5 = createHash("md5").update(file).digest("hex");
      console.log(`  Checksum ${localMd5 === created.file_md5 ? "matches Plaud's copy" : "DIFFERS from Plaud's copy"}`);
    }

    if (shareDir) {
      const manifestPath = join(shareDir, "manifest.json");
      const manifest: ShareManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.importedFileId = created.id;
      // confirm_upload returns a bare id, but Plaud's file ids carry an `of_`
      // prefix everywhere else — including the official MCP, where the bare form
      // is simply not found. Record both so the manifest is usable as-is.
      manifest.importedFileIdPrefixed = created.id ? `of_${created.id}` : undefined;
      manifest.importedAt = new Date().toISOString();
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`  Recorded the new file id in ${manifestPath}`);
      if (manifest.durationMs) console.log(`  Expect a ${humanDuration(manifest.durationMs)} recording in Plaud.`);
    }

    console.log(`\nPlaud will transcribe its copy on its own schedule. Your original transcript`);
    console.log(`stays in the archive either way — nothing overwrites it.`);
  } catch (e) {
    if (e instanceof UploadError) {
      console.error(`\n${e.message}`);
      if (e.hint) console.error(e.hint);
      process.exit(1);
    }
    throw e;
  }
}

void config; // config is loaded for its side effects (validation) before any call
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
