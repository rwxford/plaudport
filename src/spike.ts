import { config } from "./config.js";
import { PlaudClient } from "./plaudClient.js";
import type { Probe, SpikeReport } from "./types.js";
import { writeFileSync } from "node:fs";

/**
 * M0 read-only spike. Validates auth + read endpoints against your own account.
 * Write tests (import, derived-write) are GUARDED behind PLAUD_ALLOW_WRITE_TEST=true
 * and are intentionally left as TODOs until endpoints are mapped (docs/ENDPOINTS.md).
 *
 * Per decision O1: if import or derived-write cannot be validated, STOP and reassess.
 */
async function main() {
  const client = new PlaudClient();
  const probes: Probe[] = [];
  const startedAt = new Date().toISOString();

  async function readProbe(name: string, endpoint: string | null, params?: Record<string, string>) {
    if (!endpoint) {
      probes.push({ name, ok: false, skipped: true, note: "endpoint not mapped yet (see docs/ENDPOINTS.md)" });
      return;
    }
    try {
      const { status, data } = await client.get(endpoint, params);
      probes.push({ name, ok: true, status, sample: truncate(data) });
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
  // Typed as the full union (not narrowed to the initializer) so the gate below can
  // compare against true/false once the write tests actually set these.
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
    probes,
    gate: { readOk, importValidated, derivedWriteValidated, recommendation },
  };

  writeFileSync("spike-report.json", JSON.stringify(report, null, 2));
  console.log("\n=== M0 spike report ===");
  for (const p of probes) {
    const tag = p.skipped ? "SKIP" : p.ok ? "OK  " : "FAIL";
    console.log(`[${tag}] ${p.name}${p.status ? ` (${p.status})` : ""}${p.note ? ` — ${p.note}` : ""}`);
  }
  console.log("\n" + recommendation);
  console.log("Wrote spike-report.json");
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v);
  if (s && s.length > 1200) return JSON.parse(s.slice(0, 1200) + '"');
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
