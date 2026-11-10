import { existsSync, readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PipelineConfig } from "./config.js";
import { describeGap, readTokenExpiry } from "./jwt.js";
import { probeLock, type LockInfo } from "./archive/lock.js";
import { installedVersion, resolveEntry } from "./sources/plaudMcp.js";

/**
 * `plaudport doctor`, P0 subset (PRD FR21; P0-PLAN T10, P0-D1/D2, W1, W2, R7).
 * Pure over an injected environment so every branch is unit-tested. Prints
 * dates and versions, never a token value.
 */

export type Status = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  status: Status;
  detail: string;
}

export interface DoctorEnv {
  nodeVersion: string;
  platform: NodeJS.Platform;
  cfg: PipelineConfig;
  home: string;
  now: Date;
  nativeSqliteOk: () => boolean;
  installedMcpVersion: (dir: string) => string | null;
  mcpEntry: (dir: string, explicit: string) => string | null;
  readFile: (path: string) => string | null;
  freeBytes: (path: string) => number | null;
  probeLock: (root: string) => { held: boolean; info: LockInfo | null; leftoverFile: boolean };
}

/** `nativeSqliteOk` is passed in so this module never loads the native addon itself. */
export function defaultDoctorEnv(cfg: PipelineConfig, nativeSqliteOk: () => boolean): DoctorEnv {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    cfg,
    home: homedir(),
    now: new Date(),
    nativeSqliteOk,
    installedMcpVersion: installedVersion,
    mcpEntry: resolveEntry,
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    freeBytes: (p) => {
      let dir = resolve(p);
      while (!existsSync(dir) && dir !== resolve(dir, "..")) dir = resolve(dir, "..");
      try {
        const s = statfsSync(dir);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
    probeLock: (root) => (existsSync(root) ? probeLock(root) : { held: false, info: null, leftoverFile: false }),
  };
}

/** Is a path on the boot volume? (macOS: anything not under /Volumes/.) */
export function onBootVolume(path: string, platform: NodeJS.Platform): boolean {
  const p = resolve(path);
  if (platform === "darwin") return !p.startsWith("/Volumes/");
  return !/^\/(Volumes|mnt|media)\//.test(p);
}

export function runDoctor(env: DoctorEnv): { checks: Check[]; ok: boolean } {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });
  const { cfg } = env;

  const major = Number(env.nodeVersion.split(".")[0]);
  add("Node", major >= 20 ? "ok" : "fail", major >= 20 ? `v${env.nodeVersion}` : `v${env.nodeVersion} — PlaudPort needs Node 20 or newer`);

  add(
    "SQLite (better-sqlite3)",
    env.nativeSqliteOk() ? "ok" : "fail",
    env.nativeSqliteOk() ? "native module loads" : "native module did not load — run `npm rebuild better-sqlite3` (or reinstall) under this Node",
  );

  // Archive root (FR14a)
  const root = resolve(cfg.archiveRoot);
  const boot = onBootVolume(root, env.platform);
  if (boot && !cfg.backupHint) {
    add("Archive root", "warn", `${root} is on the boot volume and no backup is configured — set PLAUDPORT_BACKUP_HINT once you have one (FR14a)`);
  } else {
    add("Archive root", "ok", `${root}${cfg.backupHint ? " · backup noted" : ""}`);
  }
  const free = env.freeBytes(root);
  if (free === null) add("Disk space", "warn", "could not read free space at the archive root");
  else {
    const gb = free / 1e9;
    add("Disk space", gb < 5 ? "warn" : "ok", `${gb.toFixed(1)} GB free (expect ~2–3 GB/month of audio)`);
  }

  // Pinned MCP package (P0-D1, W1)
  if (cfg.mcpEntry) {
    const e = env.mcpEntry(cfg.mcpDir, cfg.mcpEntry);
    add("Plaud MCP", e ? "ok" : "fail", e ? "explicit PLAUDPORT_MCP_ENTRY in use" : "PLAUDPORT_MCP_ENTRY points at a file that does not exist");
  } else {
    const v = env.installedMcpVersion(cfg.mcpDir);
    if (!v) add("Plaud MCP", "fail", `@plaud-ai/mcp is not installed — run \`plaudport doctor --install-mcp\` (pins ${cfg.mcpVersion})`);
    else if (v !== cfg.mcpVersion)
      add("Plaud MCP", "warn", `installed ${v}, pinned ${cfg.mcpVersion} — run \`plaudport doctor --install-mcp\` to re-pin`);
    else if (!env.mcpEntry(cfg.mcpDir, "")) add("Plaud MCP", "fail", `installed ${v} but its entry script is missing — reinstall with --install-mcp`);
    else add("Plaud MCP", "ok", `@plaud-ai/mcp ${v} (pinned)`);
  }

  // Plaud login (P0-D2): read expiry fields only; never print a token.
  const tokenPath = join(env.home, ".plaud", "tokens-mcp.json");
  const raw = env.readFile(tokenPath);
  if (raw === null) {
    add("Plaud login", "fail", "not logged in — run `plaudport login` (opens Plaud's sign-in in your browser)");
  } else {
    let t: { expires_at?: number; refresh_token?: string } = {};
    try {
      t = JSON.parse(raw);
    } catch {
      /* unreadable */
    }
    const refresh = t.refresh_token ? readTokenExpiry(t.refresh_token, env.now.getTime()) : null;
    const accessLeft = typeof t.expires_at === "number" ? t.expires_at - env.now.getTime() : null;
    if (!t.refresh_token) {
      add("Plaud login", accessLeft !== null && accessLeft > 0 ? "warn" : "fail", "saved login has no refresh token — run `plaudport login` again");
    } else if (refresh?.expired) {
      add("Plaud login", "fail", `the saved refresh token expired ${refresh.relative} — run \`plaudport login\``);
    } else {
      const acc = accessLeft === null ? "" : accessLeft > 0 ? `access ${describeGap(accessLeft)}` : "access expired (refreshes automatically)";
      add("Plaud login", "ok", [acc, refresh ? `refresh token valid until ${refresh.expiresAt.toISOString().slice(0, 10)}` : "refresh token present"].filter(Boolean).join(" · "));
    }
  }

  // Archive lock (R7): surfaced, never broken.
  const lk = env.probeLock(root);
  if (lk.held) {
    const who = lk.info ? `pid ${lk.info.pid} on ${lk.info.host}, since ${lk.info.startedAt}` : "another process";
    add("Archive lock", "warn", `held by ${who} — a pull is running (or wedged). It is never force-broken; the OS frees it when that process exits`);
  } else {
    add("Archive lock", "ok", lk.leftoverFile ? "free (a leftover lock file from an earlier run is harmless)" : "free");
  }

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

export function renderDoctor(r: { checks: Check[]; ok: boolean }): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const w = Math.max(...r.checks.map((c) => c.name.length));
  return [
    ...r.checks.map((c) => `  ${mark[c.status]} ${c.name.padEnd(w)}  ${c.detail}`),
    "",
    r.ok ? "Ready to pull." : "Fix the ✗ items above, then run `plaudport doctor` again.",
  ].join("\n");
}
