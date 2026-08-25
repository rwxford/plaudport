import { z } from "zod";

/**
 * Central config for the M0 spike. All reverse-engineered endpoint paths live
 * here so a Plaud API change is a one-file fix. Fill the paths per docs/ENDPOINTS.md.
 */
const EnvSchema = z.object({
  PLAUD_API_BASE: z.string().url("Set PLAUD_API_BASE in .env (see docs/ENDPOINTS.md)"),
  PLAUD_TOKEN: z.string().min(10, "Set PLAUD_TOKEN in .env"),
  PLAUD_EXTRA_HEADERS: z.string().optional().default(""),
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

export const config = {
  apiBase: parsed.data.PLAUD_API_BASE.replace(/\/+$/, ""),
  token: parsed.data.PLAUD_TOKEN,
  extraHeaders,
  allowWriteTest: parsed.data.PLAUD_ALLOW_WRITE_TEST === "true",

  // SSRF guard: only these hosts may be contacted. Add the real Plaud host(s).
  allowedHosts: ["web.plaud.ai", "api.plaud.ai"],

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
