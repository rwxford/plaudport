import { z } from "zod";

/**
 * `manifest.json` — the commit point of a recording (PRD FR14b/FR14c, P0-PLAN §6).
 *
 * The manifest is the AUTHORITY for a recording's state: the SQLite ledger row
 * is re-derived from it whenever they disagree. Revision directories are
 * immutable; the manifest is replaced atomically to point at a new one. Mutable
 * observations (last seen, retry counters, per-artifact readiness) live in
 * `states` and are updated by a manifest-only swap, so a failed download does
 * not mint a revision.
 */

export const ARTIFACTS = ["transcript", "polish", "outline", "highlights", "note"] as const;
export type Artifact = (typeof ARTIFACTS)[number];

/** Where each Plaud artifact is stored inside a revision. */
export const ARTIFACT_FILE: Record<Artifact, string> = {
  transcript: "plaud/transcript.json",
  polish: "plaud/transcript-polished.json",
  outline: "plaud/outline.json",
  highlights: "plaud/highlights.json",
  note: "plaud/note.json",
};

export const AUDIO_STATES = ["audio_pending", "audio_ok", "audio_failed"] as const;
export type AudioState = (typeof AUDIO_STATES)[number];
export const ARTIFACT_STATES = ["pending", "present", "absent"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];
export const BUNDLE_STATES = ["plaud_text_pending", "plaud_text_ok", "plaud_text_absent"] as const;
export type BundleState = (typeof BUNDLE_STATES)[number];

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const RevEntrySchema = z.object({
  rev: z.string().regex(/^rev-\d{4,}$/),
  writtenAt: z.string(),
  artifacts: z.record(Sha),
});
export type RevEntry = z.infer<typeof RevEntrySchema>;

export const ArtifactStatusSchema = z.object({
  state: z.enum(ARTIFACT_STATES),
  lastCheckedAt: z.string().nullable(),
  presentRev: z.string().nullable(),
});
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const AudioStatusSchema = z.object({
  state: z.enum(AUDIO_STATES),
  attempts: z.number().int().min(0),
  lastErrorClass: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
});
export type AudioStatus = z.infer<typeof AudioStatusSchema>;

export const ManifestSchema = z.object({
  schema: z.literal(2),
  id: z.string(),
  dir: z.string(),
  startAt: z.string(),
  createdAt: z.string(),
  durationMs: z.number().nullable(),
  name: z.string().nullable(),
  serialNumber: z.string().nullable(),
  audio: z
    .object({ file: z.string(), bytes: z.number().int().min(0), sha256: Sha, fetchedAt: z.string() })
    .nullable(),
  current: RevEntrySchema,
  history: z.array(RevEntrySchema),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  states: z.object({
    audio: AudioStatusSchema,
    textBundle: z.enum(BUNDLE_STATES),
    textPendingSince: z.string().nullable(),
    artifacts: z.object(
      Object.fromEntries(ARTIFACTS.map((a) => [a, ArtifactStatusSchema])) as Record<Artifact, typeof ArtifactStatusSchema>,
    ),
  }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function parseManifest(text: string): Manifest {
  return ManifestSchema.parse(JSON.parse(text));
}

/** Stable serialization so the same manifest always hashes the same. */
export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}
