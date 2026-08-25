import { z } from "zod";

/**
 * Central config for the M0 spike. All reverse-engineered endpoint paths live
 * here so a Plaud API change is a one-file fix. Fill the paths per docs/ENDPOINTS.md.
 *
 * Every setting comes from the environment (see .env.example). Nothing secret is
 * ever hardcoded here — this file is public.
 */
const EnvSchema = z.object({
  PLAUD_API_BASE: z.string().url("Set PLAUD_API_BASE in .env (see docs/ENDPOINTS.md)"),
  PLAUD_TOKEN: z.string().min(10, "Set PLAUD_TOKEN in .env"),
  PLAUD_EXTRA_HEADERS: z.string().optional().default(""),
  PLAUD_ALLOWED_HOSTS: z.string().optional().default("web.plaud.ai,api.plaud.ai"),
  PLAUD_DATA_DIR: z.string().optional().default("./data"),
  PLAUD_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(30_000),
  PLAUD_REDACT_SAMPLES: z.string().optional().default("true"),
  PLAUD_ALLOW_WRITE_TEST: z.string().optional().default("false"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Config error:\n" + parsed.error.issues.map((i) => ` - ${i.message}`).join("\n"));
  process.exit(1);
}

let extraHeaders: Record<string, string> = {};
if (parsed.data.PLAUD_EXTRA_HEADERS.trim()) {
  try {
    extraHeaders = JSON.parse(parsed.data.PLAUD_EXTRA_HEADERS);
  } catch {
    console.error("PLAUD_EXTRA_HEADERS must be valid JSON, e.g. {\"x-workspace-id\":\"...\"}");
    process.exit(1);
  }
}

const allowedHosts = parsed.data.PLAUD_ALLOWED_HOSTS.split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

if (allowedHosts.length === 0) {
  console.error("PLAUD_ALLOWED_HOSTS must list at least one host (SSRF guard).");
  process.exit(1);
}

const apiBase = parsed.data.PLAUD_API_BASE.replace(/\/+$/, "");
const apiHost = new URL(apiBase).host.toLowerCase();
if (!allowedHosts.some((h) => apiHost === h || apiHost.endsWith("." + h))) {
  console.error(
    `PLAUD_API_BASE host (${apiHost}) is not in PLAUD_ALLOWED_HOSTS (${allowedHosts.join(", ")}).\n` +
      "Add it deliberately if it is the real Plaud host; the allowlist exists to stop typos and redirects.",
  );
  process.exit(1);
}

export const config = {
  apiBase,
  token: parsed.data.PLAUD_TOKEN,
  extraHeaders,
  allowedHosts,
  dataDir: parsed.data.PLAUD_DATA_DIR,
  requestTimeoutMs: parsed.data.PLAUD_REQUEST_TIMEOUT_MS,
  redactSamples: parsed.data.PLAUD_REDACT_SAMPLES !== "false",
  allowWriteTest: parsed.data.PLAUD_ALLOW_WRITE_TEST === "true",

  /**
   * TODO(M0): replace with the real paths captured from DevTools.
   * Leave as null for anything you haven't mapped yet; the spike will skip it.
   */
  endpoints: {
    me: "/me" as string | null,
    workspaces: null as string | null,
    // Use {workspaceId} as a placeholder token the client will substitute.
    recordings: null as string | null, // e.g. "/workspaces/{workspaceId}/recordings"
    recordingDetail: null as string | null, // e.g. "/recordings/{id}"
    transcript: null as string | null, // e.g. "/recordings/{id}/transcript"
    summary: null as string | null, // e.g. "/recordings/{id}/summary"
    audioDownload: null as string | null, // e.g. "/recordings/{id}/audio"
    importAudio: null as string | null, // POST — M0 write test
    writeDerived: null as string | null, // POST/PUT — M0 write test
    regenerate: null as string | null, // POST — optional
  },
} as const;
