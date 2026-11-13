import { join, relative, sep } from "node:path";

/**
 * Archive layout (PRD FR14, P0-PLAN §6): `<root>/<YYYY>/<MM>/<id>/`, with YYYY/MM
 * taken from the recording's `start_at` in UTC. The directory is fixed at first
 * sight; a later change to `start_at` in Plaud never moves it (the ledger
 * remembers the dir).
 */

export const STATE_DIR = ".plaudport";
export const MANIFEST = "manifest.json";
export const AUDIO = "audio.mp3";
export const META = "meta.json";

/** A Plaud file id is used as a directory name, so it must be inert. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe recording id shape (${id.length} chars); refusing to use it as a path`);
}

export function recordingRelDir(id: string, startAt: string): string {
  assertSafeId(id);
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) throw new Error("recording start_at is not a valid timestamp");
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${id}`;
}

export function absDir(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

export function relDir(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function revName(n: number): string {
  return `rev-${String(n).padStart(4, "0")}`;
}

export function revNumber(name: string): number | null {
  const m = /^rev-(\d{4,})$/.exec(name);
  return m ? Number(m[1]) : null;
}

export function lockDbPath(root: string): string {
  return join(root, STATE_DIR, "lock.sqlite");
}
export function lockInfoPath(root: string): string {
  return join(root, STATE_DIR, "lock");
}
export function ledgerPath(root: string): string {
  return join(root, STATE_DIR, "ledger.sqlite");
}
export function reportsDir(root: string): string {
  return join(root, STATE_DIR, "reports");
}
