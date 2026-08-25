import { config } from "./config.js";
import { PlaudClient } from "./plaudClient.js";
import { capSize, redactValue } from "./redact.js";
import type { Probe, SpikeReport } from "./types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * M0 read-only spike. Validates auth + read endpoints against your own account.
 * Write tests (import, derived-write) are GUARDED behind PLAUD_ALLOW_WRITE_TEST=true
 * and are intentionally left as TODOs until endpoints are mapped (docs/ENDPOINTS.md).
 *
 * Per decision O1: if import or derived-write cannot be validated, STOP and reassess.
 *
 * The report is written under PLAUD_DATA_DIR (gitignored) and its samples are
 * redacted by default — see src/redact.ts.
 */
async function main() {
  const client = new PlaudClient();
  const probes: Probe[] = [];
  const startedAt = new Date().toISOString();

  function sample(data: unknown) {
    return capSize(config.redactSamples ? redactValue(data) : data);
  }

  async function readProbe(name: string, endpoint: string | null, params?: Record<string, string>) {
    if (!endpoint) {
      probes.push({ name, ok: false, skipped: true, note: "endpoint not mapped yet (see docs/ENDPOINTS.md)" });
      return;
    }
    try {
      const { status, data } = await client.get(endpoint, params);
      probes.push({ name, ok: true, status, sample: sample(data) });
    } catch (e: any) {
      probes.push({ name, ok: false, status: e?.status, note: String(e?.message ?? e) });
    }
  }

  await readProbe("auth/me", config.endpoints.me);
  await readProbe("workspaces", config.endpoints.workspaces);
  await readProbe("recordings", config.endpoints.recordings, { workspaceId: "REPLACE_WITH_A_WORKSPACE_ID" });
  await readProbe("transcript", config.endpoints.transcript, { id: "REPLACE_WITH_A_RECORDING_ID" });
  await readProbe("summary", config.endpoints.summary, { id: "REPLACE_WITH_A_RECORDING_ID" });

  const readOk = probes.some((p) => p.ok);

  // --- GUARDED write tests (do NOT run by default) ---
  // Typed as the full union (not narrowed to the initializer) so the gate below
  // can compare against true/false once the write tests actually set these.
  let importValidated = "not-tested" as SpikeReport["gate"]["importValidated"];
  let derivedWriteValidated = "not-tested" as SpikeReport["gate"]["derivedWriteValidated"];
  if (config.allowWriteTest) {
    // TODO(M0): implement one throwaway import + derived-write against Team, then delete.
    // Keep it to a single test item. Record ok/failure here.
    probes.push({ name: "write-test", ok: false, skipped: true, note: "write test not implemented; map endpoints first" });
  }

  const finishedAt = new Date().toISOString();
  const recommendation =
    !readOk
      ? "Read probes failed — check PLAUD_API_BASE, PLAUD_TOKEN, and endpoint paths."
      : importValidated === true && derivedWriteValidated === true
      ? "Gate PASSED — proceed to M1."
      : "Read OK. Import/derived-write NOT validated — per O1, pause and reassess before building M1+.";

  const report: SpikeReport = {
    startedAt,
    finishedAt,
    apiBase: config.apiBase,
    samplesRedacted: config.redactSamples,
    probes,
    gate: { readOk, importValidated, derivedWriteValidated, recommendation },
  };

  mkdirSync(config.dataDir, { recursive: true });
  const reportPath = join(config.dataDir, "spike-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n=== M0 spike report ===");
  for (const p of probes) {
    const tag = p.skipped ? "SKIP" : p.ok ? "OK  " : "FAIL";
    console.log(`[${tag}] ${p.name}${p.status ? ` (${p.status})` : ""}${p.note ? ` — ${p.note}` : ""}`);
  }
  console.log("\n" + recommendation);
  console.log(`Wrote ${reportPath}${config.redactSamples ? " (samples redacted)" : " (RAW samples — do not share)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
