import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath, STATE_DIR } from "../archive/layout.js";
import { Ledger } from "../ledger/db.js";
import { DownloadError, downloadToPart } from "../pull/download.js";
import type { RecordingSource } from "../sources/types.js";

/**
 * Gate check G3b (P0-PLAN §9; PRD §9 (c)): a REAL presigned audio URL,
 * deliberately kept past its 24 h expiry, is rejected by storage — and a fresh
 * one from get_file then downloads the same audio. Evidence class (b).
 *
 *   start   take one archived recording's URL now and keep it
 *   finish  ≥ 24 h later: the old URL must be refused; a refreshed URL must
 *           download bytes whose sha256 equals the archived audio's
 *
 * The kept URL is a bearer credential for one recording's audio: it is stored
 * only under `<archive>/.plaudport/gate/` (owner-only, gitignored) and deleted
 * by `finish`. Nothing is written to Plaud and nothing in the archive changes;
 * downloads go to a temp dir and are removed.
 */

export const G3B_MIN_AGE_HOURS = 24;

interface Kept {
  id: string;
  url: string;
  issuedAt: string;
}

const keptPath = (root: string) => join(root, STATE_DIR, "gate", "g3b.json");

export async function g3bStart(root: string, source: RecordingSource, now = new Date()): Promise<{ issuedAt: string; finishAfter: string }> {
  if (!existsSync(ledgerPath(root))) throw new Error("no archive yet — run `plaudport pull` first");
  const l = new Ledger(ledgerPath(root), { readonly: true });
  const row = l.db.prepare("SELECT id FROM recordings WHERE audio_state='audio_ok' ORDER BY start_at DESC LIMIT 1").get() as { id: string } | undefined;
  l.close();
  if (!row) throw new Error("no recording with archived audio yet — run `plaudport pull` first");
  const d = await source.detail(row.id);
  if (!d.audioUrl) throw new Error("Plaud returned no audio URL for that recording; try again in a few minutes");
  mkdirSync(join(root, STATE_DIR, "gate"), { recursive: true, mode: 0o700 });
  const kept: Kept = { id: row.id, url: d.audioUrl, issuedAt: now.toISOString() };
  writeFileSync(keptPath(root), JSON.stringify(kept), { mode: 0o600 });
  return { issuedAt: kept.issuedAt, finishAfter: new Date(now.getTime() + G3B_MIN_AGE_HOURS * 3_600_000).toISOString() };
}

export interface G3bResult {
  ageHours: number;
  staleStatus: number | null;
  staleRefused: boolean;
  refreshedDownloaded: boolean;
  hashMatchesArchive: boolean;
  pass: boolean;
}

export async function g3bFinish(
  root: string,
  source: RecordingSource,
  opts: { isAllowedHost: (h: string) => boolean; now?: Date; minAgeHours?: number },
): Promise<G3bResult> {
  if (!existsSync(keptPath(root))) throw new Error("nothing kept — run `plaudport gate g3b start` first");
  const kept = JSON.parse(readFileSync(keptPath(root), "utf8")) as Kept;
  const now = opts.now ?? new Date();
  const ageHours = (now.getTime() - Date.parse(kept.issuedAt)) / 3_600_000;
  const minAge = opts.minAgeHours ?? G3B_MIN_AGE_HOURS;
  if (ageHours < minAge) {
    throw new Error(`the kept URL is ${ageHours.toFixed(1)} h old; run finish after ${new Date(Date.parse(kept.issuedAt) + minAge * 3_600_000).toISOString()}`);
  }
  const l = new Ledger(ledgerPath(root), { readonly: true });
  const row = l.get(kept.id);
  l.close();

  const tmp = mkdtempSync(join(tmpdir(), "plaudport-g3b-"));
  const dl = { isAllowedHost: opts.isAllowedHost, idleTimeoutMs: 60_000 };
  try {
    let staleStatus: number | null = null;
    let staleRefused = false;
    try {
      await downloadToPart(kept.url, join(tmp, "stale.part"), dl);
    } catch (e) {
      if (e instanceof DownloadError) {
        staleStatus = e.status;
        staleRefused = e.status === 403;
      } else throw e;
    }
    const fresh = await source.detail(kept.id);
    let refreshedDownloaded = false;
    let hashMatchesArchive = false;
    if (fresh.audioUrl) {
      const r = await downloadToPart(fresh.audioUrl, join(tmp, "fresh.part"), dl);
      refreshedDownloaded = true;
      hashMatchesArchive = !!row?.audio_sha256 && r.sha256 === row.audio_sha256;
    }
    rmSync(keptPath(root), { force: true }); // the kept credential is gone either way
    return {
      ageHours,
      staleStatus,
      staleRefused,
      refreshedDownloaded,
      hashMatchesArchive,
      pass: staleRefused && refreshedDownloaded && hashMatchesArchive,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
