import { config, isAllowedHost, requireApiConfig, type ApiConfig } from "./config.js";

/**
 * Thin, isolated client for the UNOFFICIAL Plaud web API.
 * Everything endpoint-specific is confined to this file (NFR4).
 */
export class PlaudClient {
  private api: ApiConfig;

  constructor() {
    // Credentials are demanded here, not at import time, so tools that never
    // call Plaud (e.g. the HAR scanner) run without a token.
    this.api = requireApiConfig();
  }

  get apiBase(): string {
    return this.api.apiBase;
  }

  private assertAllowedHost(url: string) {
    const host = new URL(url).host;
    if (!isAllowedHost(host)) throw new Error(`SSRF guard: host not allowlisted: ${host.toLowerCase()}`);
  }

  private path(p: string, params: Record<string, string> = {}) {
    let out = p;
    for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(v));
    const url = out.startsWith("http") ? out : `${this.api.apiBase}${out.startsWith("/") ? "" : "/"}${out}`;
    this.assertAllowedHost(url);
    return url;
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.api.token}`,
      Accept: "application/json",
      ...this.api.extraHeaders,
      ...extra,
    };
  }

  async get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<{ status: number; data: T }> {
    const res = await fetch(this.path(endpoint, params), {
      headers: this.headers(),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const status = res.status;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) throw Object.assign(new Error(`GET ${endpoint} -> ${status}`), { status, data });
    return { status, data: data as T };
  }

  async postJson<T = unknown>(endpoint: string, body: unknown, params?: Record<string, string>) {
    const res = await fetch(this.path(endpoint, params), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`POST ${endpoint} -> ${res.status}`), { status: res.status, data });
    return { status: res.status, data: data as T };
  }
}
