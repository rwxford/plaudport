import { manifestPath, readManifest, type Logger, type ShareManifest } from "./archive.js";
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
  /** When given, the manifest there gates duplicates and records the result. */
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
}

const noop: Logger = () => {};

/** Plaud's ids carry an `of_` prefix everywhere except confirm_upload's reply. */
export function prefixedFileId(id: string | undefined): string | undefined {
  return id ? (id.startsWith("of_") ? id : `of_${id}`) : undefined;
}

export async function importArchive(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? noop;
  const bytes = statSync(opts.audioPath).size;

  const previous: ShareManifest | null = opts.shareDir ? readManifest(opts.shareDir) : null;
  if (previous?.importedFileId && !opts.extraCopy) {
    return {
      status: "already-imported",
      fileId: previous.importedFileId,
      fileIdPrefixed: previous.importedFileIdPrefixed ?? prefixedFileId(previous.importedFileId),
      bytes,
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

  const created = await confirmUpload({
    uploadId: target.uploadId,
    objectName: target.objectName,
    filename: opts.title || basename(opts.audioPath),
    startTime: opts.startTime,
    sessionId: opts.sessionId ?? 0,
  });

  const checksumMatched = created.file_md5
    ? createHash("md5").update(file).digest("hex") === created.file_md5
    : undefined;

  if (opts.shareDir && created.id) {
    const manifest = readManifest(opts.shareDir);
    if (manifest) {
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
  };
}
