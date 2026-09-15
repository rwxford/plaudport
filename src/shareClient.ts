import { config, getDeviceId, isAllowedHost } from "./config.js";
import type { ShareRef } from "./shareUrl.js";
import { randomBytes } from "node:crypto";

/**
 * Client for Plaud's public share API, as observed on 2026-09-14.
 *
 *   GET https://api.plaud.ai/share/access/<pub_id>::<token>        -> metadata + transcript
 *   GET https://api.plaud.ai/share/access/<pub_id>::<token>/audio  -> { temp_url }
 *
 * No login, no bearer token: holding the share link is the authorisation, which
 * is exactly what makes a share link work in a browser with no Plaud account.
 *
 * Unofficial and undocumented — if Plaud changes it, it changes here and nowhere
 * else (NFR4). See docs/SHARE-API.md for the recorded response shape.
 */

// Base URL comes from config (PLAUD_SHARE_API_BASE), defaulting to api.plaud.ai.

/** Utterance in the raw or AI-polished transcript. */
export interface Utterance {
  content?: string;
  speaker?: string;
  original_speaker?: string;
  start_time?: number;
  end_time?: number;
}

export interface OutlineTopic {
  topic?: string;
  start_time?: number;
  end_time?: number;
}

export interface ShareNote {
  data_id?: string;
  data_type?: string | number;
  data_title?: string;
  data_tab_name?: string;
  data_content?: string;
}

export interface ShareDetail {
  status?: number;
  object_type?: string;
  owner_name?: string;
  is_audio?: number;
  is_trans?: number;
  is_ai_content?: number;
  data_file?: {
    id?: string;
    filename?: string;
    start_time?: number;
    duration?: number;
    file_language?: string;
    trans_result?: Utterance[];
    transaction_polish?: Utterance[];
    outline_result?: OutlineTopic[];
    notes_list?: ShareNote[];
  };
}

export class ShareApiError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * The headers Plaud's web app sends on every share call, recorded from a working
 * request (docs/SHARE-API.md).
 *
 * These are not optional: a request without `origin`/`referer`/`user-agent` gets
 * a 403, even though the endpoint needs no authentication. The API is gated on
 * looking like the web app, not on who you are. x-device-id and x-request-id are
 * values the client makes up; nothing is authenticated by them.
 */
const WEB_APP_ORIGIN = "https://web.plaud.ai";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function shareHeaders(): Record<string, string> {
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* keep UTC */
  }
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "app-language": "en",
    "app-platform": "web",
    "edit-from": "web",
    origin: WEB_APP_ORIGIN,
    referer: `${WEB_APP_ORIGIN}/`,
    timezone,
    "user-agent": BROWSER_UA,
    "x-device-id": getDeviceId(),
    "x-request-id": randomBytes(6).toString("hex"),
  };
}

async function getJson<T>(url: string): Promise<T> {
  const host = new URL(url).host;
  if (!isAllowedHost(host)) throw new ShareApiError(`SSRF guard: host not allowlisted: ${host.toLowerCase()}`);

  const res = await fetch(url, { headers: shareHeaders(), signal: AbortSignal.timeout(config.requestTimeoutMs) });

  if (!res.ok) {
    // The body usually says which of the two it is, so show a little of it.
    const body = (await res.text().catch(() => "")).trim().replace(/\s+/g, " ").slice(0, 200);
    const hint =
      res.status === 403
        ? "Two things cause a 403 here: the link was revoked, or Plaud rejected the shape of our request.\n" +
          "If the link still opens in a browser, it is the latter — Plaud changed what it expects, and\n" +
          "src/shareClient.ts needs its headers updated from a fresh browser capture (docs/SHARE-API.md)."
        : res.status === 404
          ? "The share was deleted, or the id is wrong. Open the link in a browser to check."
          : res.status >= 500
            ? "Plaud is having trouble; try again shortly."
            : undefined;
    throw new ShareApiError(`HTTP ${res.status} from ${host}${body ? `\nResponse: ${body}` : ""}`, hint);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ShareApiError("The share API returned something that isn't JSON.");
  }

  // Plaud signals application-level failure with a non-zero `status`, even on 200.
  const status = (body as { status?: number })?.status;
  if (typeof status === "number" && status !== 0) {
    throw new ShareApiError(`The share API reported status ${status}.`, "That usually means the link is invalid or expired.");
  }
  return body as T;
}

const accessUrl = (ref: ShareRef) => `${config.shareApiBase}/share/access/${ref.shareId}::${ref.accessToken}`;

/** Metadata, transcript, outline and notes for a shared recording. */
export function fetchShareDetail(ref: ShareRef): Promise<ShareDetail> {
  return getJson<ShareDetail>(accessUrl(ref));
}

/**
 * A short-lived presigned URL for the recording's audio. Fetch it immediately
 * before downloading — it expires.
 */
export async function fetchShareAudioUrl(ref: ShareRef): Promise<string> {
  const body = await getJson<{ temp_url?: string }>(`${accessUrl(ref)}/audio`);
  if (!body.temp_url) {
    throw new ShareApiError("The share API returned no audio URL.", "This share may be transcript-only.");
  }
  return body.temp_url;
}
