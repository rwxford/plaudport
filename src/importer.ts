import { manifestPath, readManifest, type ImportRecord, type Logger } from "./archive.js";
import {
  assertTokenUsable,
  confirmUpload,
  mergeParts,
  planParts,
  requestUpload,
  uploadPart,
  UploadError,
  type UploadedPart,
} from "./uploadClient.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Uploading a local audio file into the owner's Plaud workspace, as a function.
 * Shared by the single-file CLI and the batch importer.
 */

export interface ImportOptions {
  audioPath: string;
  title: string;
  /** Epoch ms — the ORIGINAL recording time, not now. */
  startTime: number;
  /** An archive folder (share or local file): its manifest gates duplicates
   *  and records the result. */
  shareDir?: string;
  extraCopy?: boolean;
  sessionId?: number;
  log?: Logger;
}

export interface ImportResult {
  status: "imported" | "already-imported";
  fileId?: string;
  fileIdPrefixed?: string;
  bytes: number;
  checksumMatched?: boolean;
  /** A copy was already in Plaud before this call. True for a skip, and for a
   *  deliberate re-import with extraCopy — so callers can say so either way. */
  wasAlreadyImported?: boolean;
  /** The id of that prior copy, when there was one. */
  previousFileIdPrefixed?: string;
}

const noop: Logger = () => {};

/** Plaud's ids carry an `of_` prefix everywhere except confirm_upload's reply. */
export function prefixedFileId(id: string | undefined): string | undefined {
  return id ? (id.startsWith("of_") ? id : `of_${id}`) : undefined;
}

export async function importArchive(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? noop;
  const bytes = statSync(opts.audioPath).size;

  const previous = opts.shareDir ? readManifest<ImportRecord>(opts.shareDir) : null;
  if (previous?.importConfirmationPending) {
    throw new UploadError("Plaud may already have this recording. Check Personal before importing again. Automatic retry is blocked to avoid a duplicate.",
      "See README troubleshooting for an uncertain upload confirmation.");
  }
  const previousFileIdPrefixed = previous?.importedFileId
    ? (previous.importedFileIdPrefixed ?? prefixedFileId(previous.importedFileId))
    : undefined;
  if (previous?.importedFileId && !opts.extraCopy) {
    return {
      status: "already-imported",
      fileId: previous.importedFileId,
      fileIdPrefixed: previousFileIdPrefixed,
      bytes,
      wasAlreadyImported: true,
      previousFileIdPrefixed,
    };
  }

  assertTokenUsable();

  const target = await requestUpload(bytes);
  const file = readFileSync(opts.audioPath);
  const ranges = planParts(file.length, target.partUrls.length);

  if (ranges.length !== target.partUrls.length) {
    throw new UploadError(
      `Plaud asked for ${target.partUrls.length} parts but this file splits into ${ranges.length}.`,
      "Plaud's part size has probably changed; PART_SIZE in src/uploadClient.ts needs updating.",
    );
  }

  const parts: UploadedPart[] = [];
  for (const [i, url] of target.partUrls.entries()) {
    const range = ranges[i]!;
    log(`  Uploading part ${range.partNumber} of ${ranges.length}…`);
    parts.push(await uploadPart(url, range.partNumber, file.subarray(range.start, range.end)));
  }

  await mergeParts(target.uploadId, target.objectName, parts);

  // Persist BEFORE the write that creates a Plaud recording. If the response
  // is lost (or saving its id fails), retrying must not create another copy.
  if (opts.shareDir) {
    const manifest = readManifest<ImportRecord>(opts.shareDir);
    if (!manifest) throw new UploadError("The backup manifest is missing. Restore it before importing.");
    manifest.importConfirmationPending = true;
    writeFileSync(manifestPath(opts.shareDir), JSON.stringify(manifest, null, 2));
  }
  const created = await confirmUpload({
    uploadId: target.uploadId,
    objectName: target.objectName,
    filename: opts.title || basename(opts.audioPath),
    startTime: opts.startTime,
    sessionId: opts.sessionId ?? 0,
  });

  if (typeof created?.id !== "string" || !created.id.trim()) {
    throw new UploadError("Plaud did not return a recording ID. Check Personal before importing again; the recording may already exist.");
  }

  const checksumMatched = created.file_md5
    ? createHash("md5").update(file).digest("hex") === created.file_md5
    : undefined;

  if (opts.shareDir && created.id) {
    const manifest = readManifest<ImportRecord>(opts.shareDir);
    if (manifest) {
      delete manifest.importConfirmationPending;
      manifest.importedFileId = created.id;
      manifest.importedFileIdPrefixed = prefixedFileId(created.id);
      manifest.importedAt = new Date().toISOString();
      writeFileSync(manifestPath(opts.shareDir), JSON.stringify(manifest, null, 2));
    }
  }

  return {
    status: "imported",
    fileId: created.id,
    fileIdPrefixed: prefixedFileId(created.id),
    bytes,
    checksumMatched,
    wasAlreadyImported: Boolean(previousFileIdPrefixed),
    previousFileIdPrefixed,
  };
}
