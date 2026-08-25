import { config } from "./config.js";

/**
 * Thin, isolated client for the UNOFFICIAL Plaud web API.
 * Everything endpoint-specific is confined to this file (NFR4).
 */
export class PlaudClient {
  private base = config.apiBase;

  private assertAllowedHost(url: string) {
    const host = new URL(url).host;
    const ok = config.allowedHosts.some((h) => host === h || host.endsWith("." + h));
    if (!ok) throw new Error(`SSRF guard: host not allowlisted: ${host}`);
  }

  private path(p: string, params: Record<string, string> = {}) {
    let out = p;
    for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(v));
    const url = out.startsWith("http") ? out : `${this.base}${out.startsWith("/") ? "" : "/"}${out}`;
    this.assertAllowedHost(url);
    return url;
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
      ...config.extraHeaders,
      ...extra,
    };
  }

  async get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<{ status: number; data: T }> {
    const res = await fetch(this.path(endpoint, params), { headers: this.headers() });
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
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`POST ${endpoint} -> ${res.status}`), { status: res.status, data });
    return { status: res.status, data: data as T };
  }
}
