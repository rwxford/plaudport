import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordingFacts } from "../archive/revision.js";
import { initialArtifacts, initialAudio } from "../pull/states.js";

/** A fresh, empty archive root in the OS temp dir. */
export function tempRoot(label = "pp"): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

/** Synthetic recording facts — never a real id or title. */
export function facts(n = 1, startAt = "2026-11-03T15:00:00.000Z"): RecordingFacts {
  return {
    id: `of_fake${String(n).padStart(6, "0")}`,
    startAt,
    createdAt: startAt,
    durationMs: 60_000,
    name: `Synthetic recording ${n}`,
    serialNumber: null,
  };
}

export function initInput(n = 1, now = new Date("2026-11-03T16:00:00.000Z"), startAt?: string) {
  const f = facts(n, startAt);
  const d = new Date(f.startAt);
  const rel = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${f.id}`;
  return { facts: f, rel, listing: { id: f.id }, now, audio: initialAudio(), artifacts: initialArtifacts() };
}
