import {
  ARTIFACTS,
  type Artifact,
  type ArtifactState,
  type ArtifactStatus,
  type AudioStatus,
  type BundleState,
} from "../archive/manifest.js";

/**
 * Pure readiness state machines (PRD FR1b, FR1c; P0-PLAN §4). No I/O: every
 * function takes `(state, event, now, config)` and returns the next state, so
 * the whole table is unit-tested exhaustively in states.test.ts.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const BASE_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = DAY_MS;
/** A presigned URL is valid 24 h; refresh it proactively once it is this old. */
export const URL_REFRESH_AFTER_MS = 23 * HOUR_MS;

export function initialAudio(): AudioStatus {
  return { state: "audio_pending", attempts: 0, lastErrorClass: null, nextRetryAt: null };
}

export function initialArtifacts(): Record<Artifact, ArtifactStatus> {
  return Object.fromEntries(
    ARTIFACTS.map((a) => [a, { state: "pending", lastCheckedAt: null, presentRev: null }]),
  ) as Record<Artifact, ArtifactStatus>;
}

/** Un-jittered backoff after `attempts` failures: min(2^attempts × 15 min, 24 h). */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts) * BASE_BACKOFF_MS, MAX_BACKOFF_MS);
}

/** Backoff with ±20% jitter; `rand` ∈ [0,1). The cap applies before jitter. */
export function jitteredBackoffMs(attempts: number, rand: number): number {
  const base = backoffMs(attempts);
  return Math.round(base * (0.8 + 0.4 * Math.min(Math.max(rand, 0), 1)));
}

export type AudioEvent =
  | { kind: "download_ok" }
  | { kind: "download_failed"; errorClass: string }
  /** A URL that expired (403 or older than 23 h) is not an attempt (FR1c). */
  | { kind: "url_expired" };

export function nextAudio(s: AudioStatus, ev: AudioEvent, now: Date, rand: number = Math.random()): AudioStatus {
  switch (ev.kind) {
    case "download_ok":
      return { state: "audio_ok", attempts: s.attempts, lastErrorClass: null, nextRetryAt: null };
    case "url_expired":
      return s;
    case "download_failed": {
      if (s.state === "audio_ok") return s; // never regress a verified download
      const attempts = s.attempts + 1;
      return {
        state: "audio_failed",
        attempts,
        lastErrorClass: ev.errorClass,
        nextRetryAt: new Date(now.getTime() + jitteredBackoffMs(attempts, rand)).toISOString(),
      };
    }
  }
}

/** Is this recording's audio due for a download attempt now? Never gives up (FR1c). */
export function audioDue(s: AudioStatus, now: Date): boolean {
  if (s.state === "audio_pending") return true;
  if (s.state === "audio_failed") return !s.nextRetryAt || Date.parse(s.nextRetryAt) <= now.getTime();
  return false;
}

/** Proactive refresh rule: a URL issued ≥ 23 h ago is re-fetched before use. */
export function urlNeedsRefresh(issuedAt: string, now: Date, debugAgeHours: number | null = null): boolean {
  const age = debugAgeHours !== null ? debugAgeHours * HOUR_MS : now.getTime() - Date.parse(issuedAt);
  return age >= URL_REFRESH_AFTER_MS;
}

// --- Plaud text, per artifact (C2) ------------------------------------------

/** Has the bundle passed its age-out deadline? (strictly greater, per §4) */
export function pastTextDeadline(textPendingSince: string | null, now: Date, timeoutDays: number): boolean {
  if (!textPendingSince) return false;
  return now.getTime() - Date.parse(textPendingSince) > timeoutDays * DAY_MS;
}

export function pendingArtifacts(a: Record<Artifact, ArtifactStatus>): Artifact[] {
  return ARTIFACTS.filter((k) => a[k].state === "pending");
}

/**
 * Apply one text check. `observed` says which artifacts now have content (only
 * meaningful when `fetched`); `presentRev` is the revision that will carry any
 * newly-present ones. Past the deadline, still-pending artifacts become
 * `absent` WITHOUT a fetch (R2-2). Already-resolved artifacts never change.
 */
export function applyTextCheck(
  a: Record<Artifact, ArtifactStatus>,
  ev:
    | { pastDeadline: true }
    | { pastDeadline: false; observed: Partial<Record<Artifact, boolean | "absent">>; presentRev: string | null },
  now: Date,
): Record<Artifact, ArtifactStatus> {
  const at = now.toISOString();
  const out = { ...a };
  for (const k of ARTIFACTS) {
    const cur = a[k];
    if (cur.state !== "pending") continue;
    if (ev.pastDeadline) {
      out[k] = { state: "absent", lastCheckedAt: cur.lastCheckedAt, presentRev: null };
    } else if (ev.observed[k] === "absent") {
      // A final "empty" answer (e.g. a highlights block with no presses).
      out[k] = { state: "absent", lastCheckedAt: at, presentRev: null };
    } else if (ev.observed[k]) {
      if (!ev.presentRev) throw new Error("a newly-present artifact needs the revision that carries it");
      out[k] = { state: "present", lastCheckedAt: at, presentRev: ev.presentRev };
    } else {
      out[k] = { ...cur, lastCheckedAt: at };
    }
  }
  return out;
}

/** Bundle state derived from the five artifacts (FR1b). */
export function deriveBundle(a: Record<Artifact, ArtifactStatus>): BundleState {
  const states: ArtifactState[] = ARTIFACTS.map((k) => a[k].state);
  if (states.some((s) => s === "pending")) return "plaud_text_pending";
  if (states.every((s) => s === "absent")) return "plaud_text_absent";
  return "plaud_text_ok";
}

/** `--recheck-text`: reopen absent artifacts; the age-out clock restarts now. */
export function reopenAbsent(a: Record<Artifact, ArtifactStatus>): Record<Artifact, ArtifactStatus> {
  const out = { ...a };
  for (const k of ARTIFACTS) if (a[k].state === "absent") out[k] = { state: "pending", lastCheckedAt: a[k].lastCheckedAt, presentRev: null };
  return out;
}
