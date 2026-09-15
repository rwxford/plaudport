import { loadEnvFile, unwrapValue } from "./env.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Central config. All reverse-engineered endpoint paths live here so a Plaud API
 * change is a one-file fix. Fill the paths per docs/ENDPOINTS.md.
 *
 * Split in two on purpose:
 *   - `config`          non-secret settings, always available
 *   - `requireApiConfig()`  credentials, demanded only by code that calls Plaud
 *
 * That split is what lets `npm run scan:har` work before you have a token, which
 * is exactly when you need it.
 *
 * Every setting comes from the environment (see .env.example). Nothing secret is
 * ever hardcoded here — this file is public.
 */

// Before anything reads process.env: real env vars still win over the file.
loadEnvFile();

const SettingsSchema = z.object({
  PLAUD_ALLOWED_HOSTS: z
    .string()
    .optional()
    // resource.plaud.ai serves thumbnails; the S3 bucket is where share audio is
    // presigned from (observed 2026-09-14). Override via .env if Plaud moves.
    .default(
      "web.plaud.ai,api.plaud.ai,resource.plaud.ai," +
        // share audio is served from one bucket host and uploaded to another
        "plaud-bucket.s3.us-west-2.amazonaws.com,plaud-bucket.s3-accelerate.amazonaws.com",
    ),
  PLAUD_SHARE_API_BASE: z.string().url().optional().default("https://api.plaud.ai"),
  PLAUD_DATA_DIR: z.string().optional().default("./data"),
  PLAUD_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(30_000),
  PLAUD_REDACT_SAMPLES: z.string().optional().default("true"),
  PLAUD_ALLOW_WRITE_TEST: z.string().optional().default("false"),
});

const settings = SettingsSchema.safeParse(process.env);
if (!settings.success) {
  console.error("Config error:\n" + settings.error.issues.map((i) => ` - ${i.message}`).join("\n"));
  process.exit(1);
}

const allowedHosts = settings.data.PLAUD_ALLOWED_HOSTS.split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

if (allowedHosts.length === 0) {
  console.error("PLAUD_ALLOWED_HOSTS must list at least one host (SSRF guard).");
  process.exit(1);
}

/**
 * Accepts either a hostname or a `host:port` — URL.host carries the port, and an
 * allowlist entry is a hostname, so the port is stripped before comparing.
 */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1) || h; // IPv6 literal
  const colon = h.indexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

export function isAllowedHost(host: string): boolean {
  const h = hostnameOf(host);
  return allowedHosts.some((a) => {
    const allowed = hostnameOf(a);
    return h === allowed || h.endsWith("." + allowed);
  });
}

export const config = {
  allowedHosts,
  // Base for the public share API. Overridable so the self-test can point at a
  // local stand-in, and so a Plaud move is a config change rather than a patch.
  shareApiBase: settings.data.PLAUD_SHARE_API_BASE.replace(/\/+$/, ""),
  dataDir: settings.data.PLAUD_DATA_DIR,
  requestTimeoutMs: settings.data.PLAUD_REQUEST_TIMEOUT_MS,
  redactSamples: settings.data.PLAUD_REDACT_SAMPLES !== "false",
  allowWriteTest: settings.data.PLAUD_ALLOW_WRITE_TEST === "true",

  /**
   * TODO(M0): replace with the real paths captured from DevTools.
   * `npm run scan:har -- <file.har>` proposes these for you.
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

/**
 * The `x-pld-user` header value, which authenticates writes to your own Plaud
 * workspace. Demanded only by code that uploads, so every read-only tool keeps
 * working without it. Full account access — keep it in .env, never in the repo.
 */
let cachedUserToken: string | null = null;

/**
 * The `x-device-id` the Plaud web app sends. It is STABLE per browser session,
 * and a session token may well be bound to it — so a fresh random id on every
 * request is a good way to look like a different device each time. Configurable
 * via PLAUD_DEVICE_ID; otherwise one value is generated per process, never per
 * request.
 */
let deviceId: string | null = null;

export function getDeviceId(): string {
  if (deviceId) return deviceId;
  const configured = unwrapValue(process.env.PLAUD_DEVICE_ID ?? "");
  deviceId = configured || randomBytes(8).toString("hex");
  return deviceId;
}

export function requireUserToken(): string {
  if (cachedUserToken) return cachedUserToken;
  const token = unwrapValue(process.env.PLAUD_USER_TOKEN ?? "");
  if (token.length < 10) {
    console.error(
      "PLAUD_USER_TOKEN is not set.\n" +
        "It is the `x-pld-user` header the Plaud web app sends when you are signed in.\n" +
        "See docs/UPLOAD-API.md for how to capture it, then put it in .env (which is gitignored).",
    );
    process.exit(1);
  }
  cachedUserToken = token;
  return token;
}

const CredentialsSchema = z.object({
  PLAUD_API_BASE: z.string().url("Set PLAUD_API_BASE in .env (see docs/ENDPOINTS.md)"),
  PLAUD_TOKEN: z.string().min(10, "Set PLAUD_TOKEN in .env"),
  PLAUD_EXTRA_HEADERS: z.string().optional().default(""),
});

export interface ApiConfig {
  apiBase: string;
  token: string;
  extraHeaders: Record<string, string>;
}

let cached: ApiConfig | null = null;

/** Credentials for talking to Plaud. Exits with a readable error if unusable. */
export function requireApiConfig(): ApiConfig {
  if (cached) return cached;

  const parsed = CredentialsSchema.safeParse(process.env);
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

  const apiBase = parsed.data.PLAUD_API_BASE.replace(/\/+$/, "");
  const apiHost = new URL(apiBase).host;
  if (!isAllowedHost(apiHost)) {
    console.error(
      `PLAUD_API_BASE host (${apiHost.toLowerCase()}) is not in PLAUD_ALLOWED_HOSTS (${allowedHosts.join(", ")}).\n` +
        "Add it deliberately if it is the real Plaud host; the allowlist exists to stop typos and redirects.",
    );
    process.exit(1);
  }

  cached = { apiBase, token: parsed.data.PLAUD_TOKEN, extraHeaders };
  return cached;
}
