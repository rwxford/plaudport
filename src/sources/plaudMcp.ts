import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AuthError,
  SourceError,
  type PlaudText,
  type RecordingDetail,
  type RecordingSource,
  type RecordingSummary,
  type SourceStats,
  type TranscriptBlock,
  type TranscriptBlockName,
} from "./types.js";

/**
 * `plaud-mcp` adapter (FR2; P0-PLAN §5, P0-D1/D2).
 *
 * Drives Plaud's official `@plaud-ai/mcp` server over stdio. The package is
 * pin-installed once (doctor --install-mcp) and its entry exec'd directly — no
 * `npx` resolve per run (W1). It owns OAuth and token refresh; PlaudPort never
 * sees a token.
 *
 * The child gets a MINIMAL environment: PlaudPort's own .env holds PLAUD_* web
 * credentials and a PLAUD_API_BASE that the package would otherwise pick up as
 * its API base. Telemetry is always disabled (F9).
 */

export const PACKAGE = "@plaud-ai/mcp";

/** Env vars the child may inherit (proxies, CA bundles, locale, home). */
const PASS_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

export function childEnv(parent: Record<string, string | undefined> = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  env.PLAUD_TELEMETRY_DISABLED = "1";
  return { ...env, ...extra };
}

/** Where the pinned package's entry script lives inside the managed dir. */
export function installedPackageDir(mcpDir: string): string {
  return join(mcpDir, "node_modules", ...PACKAGE.split("/"));
}

export function installedVersion(mcpDir: string): string | null {
  const p = join(installedPackageDir(mcpDir), "package.json");
  if (!existsSync(p)) return null;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export function resolveEntry(mcpDir: string, explicitEntry = ""): string | null {
  if (explicitEntry) return existsSync(explicitEntry) ? explicitEntry : null;
  const pkgDir = installedPackageDir(mcpDir);
  const pj = join(pkgDir, "package.json");
  if (!existsSync(pj)) return null;
  const pkg = JSON.parse(readFileSync(pj, "utf8")) as { bin?: string | Record<string, string>; main?: string };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : pkg.main;
  if (!bin) return null;
  const entry = join(pkgDir, bin);
  return existsSync(entry) ? entry : null;
}

// --- response parsing --------------------------------------------------------

/**
 * The package wraps recording data in a randomly-named tag so instruction-like
 * text inside it cannot escape. We take ONLY the payload between the opening
 * tag and its exact closing tag, and treat it as data.
 */
export function unwrapUntrusted(text: string): string | null {
  // The preamble NAMES the tag (`<tag>`); the real opening tag carries
  // attributes (`<tag source="…">`). Anchor on the closing tag, then on the
  // attributed opening tag of that exact name.
  const close = /<\/(untrusted-user-data-[0-9a-f]+)>\s*(?:\n[\s\S]*)?$/.exec(text);
  const tag = close?.[1];
  if (!tag) return null;
  const end = text.lastIndexOf(`</${tag}>`);
  const open = new RegExp(`<${tag}\\s[^>]*>\\n?`).exec(text);
  if (!open || open.index + open[0].length > end) return null;
  return text.slice(open.index + open[0].length, end).replace(/\n$/, "");
}

/** Plaud timestamps may lack a zone (they are UTC) or be epoch numbers. */
export function normalizeTimestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v !== "string") return null;
  const t = v.trim();
  const zoned = /\d{2}:\d{2}/.test(t) && !/(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(t) ? `${t}Z` : t;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const Stamp = z.union([z.string(), z.number()]).nullish();
const ListItem = z
  .object({
    id: z.string().min(1),
    name: z.string().nullish(),
    created_at: Stamp,
    start_at: Stamp,
    duration: z.number().nullish(),
    serial_number: z.string().nullish(),
  })
  .passthrough();
const ListResult = z.object({ data: z.array(ListItem) }).passthrough();
const FileResult = ListItem.extend({ presigned_url: z.string().nullish() });
const TranscriptPage = z
  .object({ next_cursor: z.string().nullish(), segments: z.array(z.unknown()).optional(), marks: z.array(z.unknown()).optional() })
  .passthrough();

function toSummary(item: z.infer<typeof ListItem>): RecordingSummary {
  const createdAt = normalizeTimestamp(item.created_at);
  const startAt = normalizeTimestamp(item.start_at) ?? createdAt;
  if (!startAt || !createdAt) throw new SourceError("recording without usable timestamps", "schema");
  return {
    id: item.id,
    name: item.name ?? null,
    startAt,
    createdAt,
    durationMs: item.duration ?? null,
    serialNumber: item.serial_number ?? null,
    raw: stripSecrets(item),
  };
}

/** Remove presigned links from anything we persist (they are bearer URLs). */
export function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "presigned_url" || k === "data_link") continue;
      out[k] = stripSecrets(val);
    }
    return out;
  }
  return v;
}

const AUTH_SIGNS = /not authenticated|please login|\b401\b|token refresh failed|unauthori[sz]ed/i;
const RATE_SIGN = /\b429\b|too many requests/i;
const RETRY_SIGN = /\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i;

export const LOGIN_HINT =
  "Plaud is not logged in (or the saved login expired). Run `plaudport login` once — it opens your browser for Plaud's own sign-in — then `plaudport doctor`.";

export function classifyToolError(text: string): "auth" | "rate" | "retry" | "fatal" {
  if (AUTH_SIGNS.test(text)) return "auth";
  if (RATE_SIGN.test(text)) return "rate";
  if (RETRY_SIGN.test(text)) return "retry";
  return "fatal";
}

// --- the adapter ---------------------------------------------------------------

export interface PlaudMcpOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Minimum spacing between tool calls (P0-PLAN §7: 250 ms). */
  minSpacingMs?: number;
  /** Base for exponential backoff on 429/5xx. */
  backoffBaseMs?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

export async function createPlaudMcpSource(opts: PlaudMcpOptions): Promise<RecordingSource & { callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string> }> {
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: opts.env ?? childEnv(),
    stderr: "pipe", // the package logs file ids; never echo it
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "plaudport", version: "p0" });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new SourceError(`could not start the Plaud MCP server (${(e as Error).name})`, "mcp_spawn");
  }

  const spacing = opts.minSpacingMs ?? 250;
  const base = opts.backoffBaseMs ?? 1000;
  const maxRetries = opts.maxRetries ?? 5;
  const timeout = opts.requestTimeoutMs ?? 60_000;
  const stats: SourceStats = { requests: 0, rateLimited: 0, retries: 0 };
  let last = 0;

  async function callTool(name: string, args: Record<string, unknown>, timeoutMs = timeout): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const wait = last + spacing - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      stats.requests++;
      let res;
      try {
        res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      } catch (e) {
        if (attempt < maxRetries) {
          stats.retries++;
          await new Promise((r) => setTimeout(r, base * 2 ** attempt));
          continue;
        }
        throw new SourceError(`Plaud MCP call failed (${(e as Error).name})`, "mcp_transport");
      }
      const text = ((res.content as { type: string; text?: string }[]) ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (!res.isError) return text;
      const kind = classifyToolError(text);
      if (kind === "auth") throw new AuthError(LOGIN_HINT);
      if (kind === "rate") stats.rateLimited++;
      if ((kind === "rate" || kind === "retry") && attempt < maxRetries) {
        stats.retries++;
        await new Promise((r) => setTimeout(r, base * 2 ** attempt));
        continue;
      }
      throw new SourceError(`Plaud MCP ${name} failed`, kind === "rate" ? "rate_limited" : kind === "retry" ? "upstream" : "tool_error");
    }
  }

  function data(text: string): unknown {
    const inner = unwrapUntrusted(text);
    if (inner === null) throw new SourceError("unexpected (unwrapped) MCP response", "schema");
    try {
      return JSON.parse(inner);
    } catch {
      throw new SourceError("MCP response was not JSON", "schema");
    }
  }

  async function block(id: string, name: TranscriptBlockName): Promise<TranscriptBlock> {
    const items: unknown[] = [];
    const done = (): TranscriptBlock => ({ block: name, items, status: items.length ? "items" : "empty" });
    let cursor: string | undefined;
    for (let guard = 0; guard < 10_000; guard++) {
      const args: Record<string, unknown> = { file_id: id, block: name, limit: 500 };
      if (cursor) args.cursor = cursor;
      const text = await callTool("get_transcript", args);
      const inner = unwrapUntrusted(text);
      if (inner === null) {
        // Plain-text status lines from the package: "…but it is empty…" is a
        // final answer; "not available" / "no content … yet" mean pending.
        if (items.length) return done();
        return { block: name, items, status: /\bis empty\b/i.test(text) ? "empty" : "unavailable" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(inner);
      } catch {
        if (inner.trim()) items.push(inner); // a non-JSON block body is one item
        return done();
      }
      if (Array.isArray(parsed) && !cursor) return { block: name, items, status: "unavailable" }; // empty source_list
      const page = TranscriptPage.safeParse(parsed);
      if (page.success && (page.data.segments || page.data.marks)) {
        items.push(...(page.data.segments ?? page.data.marks ?? []));
        if (!page.data.next_cursor) return done();
        cursor = page.data.next_cursor;
        continue;
      }
      // A non-list JSON block (e.g. an outline object) is one item.
      if (parsed !== null && parsed !== "") items.push(parsed);
      return done();
    }
    throw new SourceError("transcript paging did not terminate", "schema");
  }

  return {
    name: "plaud-mcp",
    callTool,
    async list(window, page) {
      const text = await callTool("list_files", {
        page: page.page,
        page_size: Math.max(10, page.pageSize),
        date_from: window.from,
        date_to: window.to,
      });
      const r = ListResult.safeParse(data(text));
      if (!r.success) throw new SourceError("list_files response did not match the expected shape", "schema");
      return r.data.data.map(toSummary);
    },
    async detail(id) {
      const issuedAt = new Date().toISOString();
      const r = FileResult.safeParse(data(await callTool("get_file", { file_id: id })));
      if (!r.success) throw new SourceError("get_file response did not match the expected shape", "schema");
      return {
        ...toSummary(r.data),
        audioUrl: r.data.presigned_url ?? null,
        audioUrlIssuedAt: issuedAt,
        rawDetail: stripSecrets(r.data),
      };
    },
    async text(id): Promise<PlaudText> {
      const transcript: TranscriptBlock[] = [];
      for (const b of ["transaction", "transaction_polish", "outline", "mark_memo"] as const) transcript.push(await block(id, b));
      const noteText = await callTool("get_note", { file_id: id });
      const inner = unwrapUntrusted(noteText);
      let note: unknown[] | null = null;
      if (inner !== null) {
        try {
          const parsed = JSON.parse(inner);
          note = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          note = inner.trim() ? [inner] : null;
        }
      }
      return { transcript, note };
    },
    async health() {
      try {
        await callTool("get_current_user", {});
        return { ok: true, note: "authenticated" };
      } catch (e) {
        if (e instanceof AuthError) return { ok: false, note: e.message };
        return { ok: false, note: `could not reach Plaud (${(e as SourceError).errorClass ?? "error"})` };
      }
    },
    stats: () => ({ ...stats }),
    async close() {
      await client.close().catch(() => {});
    },
  };
}
