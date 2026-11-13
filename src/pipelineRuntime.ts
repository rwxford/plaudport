import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "./config.js";
import { childEnv, createPlaudMcpSource, PACKAGE, resolveEntry } from "./sources/plaudMcp.js";

/** Wiring shared by the v2 CLI commands (pull, login, doctor). */

export class SetupError extends Error {}

export function mcpEntryOrThrow(cfg: PipelineConfig): string {
  const entry = resolveEntry(cfg.mcpDir, cfg.mcpEntry);
  if (!entry) {
    throw new SetupError(
      cfg.mcpEntry
        ? "PLAUDPORT_MCP_ENTRY points at a file that does not exist."
        : `Plaud's MCP package is not installed. Run \`plaudport doctor --install-mcp\` once (it pins ${PACKAGE}@${cfg.mcpVersion}).`,
    );
  }
  return entry;
}

export function openMcpSource(cfg: PipelineConfig, requestTimeoutMs: number) {
  const entry = mcpEntryOrThrow(cfg);
  return createPlaudMcpSource({
    command: process.execPath,
    args: [entry],
    env: childEnv(),
    requestTimeoutMs: Math.max(60_000, requestTimeoutMs),
  });
}

/**
 * Pin-install the MCP package into the managed dir (P0-D1, W1): one network
 * resolve now, none per run. Scripts are not run; the package is plain JS.
 */
export function installMcp(cfg: PipelineConfig): { ok: boolean; detail: string } {
  mkdirSync(cfg.mcpDir, { recursive: true, mode: 0o700 });
  const pj = join(cfg.mcpDir, "package.json");
  if (!existsSync(pj)) writeFileSync(pj, JSON.stringify({ name: "plaudport-mcp", private: true }, null, 2) + "\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(
    npm,
    ["install", "--prefix", cfg.mcpDir, "--save-exact", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `${PACKAGE}@${cfg.mcpVersion}`],
    { stdio: "inherit", env: { ...process.env, PLAUD_TELEMETRY_DISABLED: "1" } },
  );
  return r.status === 0
    ? { ok: true, detail: `${PACKAGE}@${cfg.mcpVersion} installed in ${cfg.mcpDir}` }
    : { ok: false, detail: `npm install failed (exit ${r.status ?? "?"})` };
}
