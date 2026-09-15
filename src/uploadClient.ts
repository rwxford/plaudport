import { config, getDeviceId, isAllowedHost, requireUserToken } from "./config.js";
import { unwrapValue } from "./env.js";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Client for Plaud's audio upload flow, as observed on 2026-09-15.
 * See docs/UPLOAD-API.md. All endpoint knowledge lives here (NFR4).
 *
 *   1. POST /file/get_upload_presigned_url  -> part URLs + upload_id + object_name
 *   2. PUT  each part to S3                 -> an ETag per part
 *   3. POST /file/merge_multipart           -> reassemble
 *   4. POST /file/confirm_upload            -> the file record exists
 *
 * Authenticated by the `x-pld-user` header, not a bearer token.
 */

/** S3 multipart minimum; the observed 9.3 MB upload split into exactly 2 parts. */
export const PART_SIZE = 5 * 1024 * 1024;

export interface PresignedUpload {
  partUrls: string[];
  uploadId: string;
  objectName: string;
}

export interface UploadedPart {
  Etag: string;
  PartNumber: number;
}

export interface ConfirmedFile {
  id?: string;
  workspace_id?: string;
  filename?: string;
  filesize?: number;
  file_md5?: string;
  start_time?: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const WEB_APP_ORIGIN = "https://web.plaud.ai";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** The `timezone` HEADER is an IANA name; the confirm_upload FIELD is an offset. */
export function ianaTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** UTC offset in hours, the way confirm_upload wants it (e.g. -4), not an IANA name. */
export function utcOffsetHours(date = new Date()): number {
  return -date.getTimezoneOffset() / 60;
}

/**
 * fetch throws a bare TypeError when the network fails, which reaches the user
 * as an unreadable stack trace. Turn it into something that says what happened.
 */
async function withNetworkErrors(host: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.name;
    const hint =
      cause === "ENOTFOUND" || cause === "EAI_AGAIN"
        ? "Check your internet connection or DNS."
        : cause === "ECONNREFUSED"
          ? "Nothing is listening there. Check PLAUD_SHARE_API_BASE in .env."
          : cause === "TimeoutError"
            ? "The upload timed out. A slow connection may need a larger PLAUD_REQUEST_TIMEOUT_MS."
            : undefined;
    throw new UploadError(`Could not reach ${host}${cause ? ` (${cause})` : ""}`, hint);
  }
}

function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  // Chrome's "Export HAR (sanitized)" strips Authorization and Cookie, so a
  // capture can look credential-free when it was not. Both are supported and
  // sent when set; x-pld-user alone may not be what authenticates these calls.
  const cookie = unwrapValue(process.env.PLAUD_COOKIE ?? "");
  const auth = unwrapValue(process.env.PLAUD_AUTH ?? "");
  return {
    ...(cookie ? { cookie } : {}),
    // Accepts a bare token or a full "Bearer x" value — people copy both.
    ...(auth ? { authorization: /^bearer /i.test(auth) ? auth : `Bearer ${auth}` } : {}),
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "app-language": "en",
    "app-platform": "web",
    "edit-from": "web",
    timezone: ianaTimezone(),
    origin: WEB_APP_ORIGIN,
    referer: `${WEB_APP_ORIGIN}/`,
    "user-agent": BROWSER_UA,
    "x-device-id": getDeviceId(),
    "x-request-id": randomBytes(6).toString("hex"),
    "x-pld-user": token,
    ...extra,
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const token = requireUserToken();
  const url = `${config.shareApiBase}${path}`;
  const host = new URL(url).host;
  if (!isAllowedHost(host)) throw new UploadError(`SSRF guard: host not allowlisted: ${host.toLowerCase()}`);

  const res = await withNetworkErrors(host, () =>
    fetch(url, {
      method: "POST",
      headers: apiHeaders(token, { "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }),
  );

  const text = await res.text();
  if (!res.ok) {
    throw new UploadError(
      `HTTP ${res.status} from ${path}${text ? `\nResponse: ${text.slice(0, 200)}` : ""}`,
      res.status === 401 || res.status === 403
        ? "Your PLAUD_USER_TOKEN is wrong or expired. Capture a fresh x-pld-user value (docs/UPLOAD-API.md)."
        : undefined,
    );
  }

  let parsed: { status?: number; msg?: string; message?: string; data?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UploadError(`${path} returned something that isn't JSON.`);
  }

  // Plaud reports failure in the body, not the HTTP status.
  if (typeof parsed.status === "number" && parsed.status !== 0) {
    throw new UploadError(`${path} reported status ${parsed.status}: ${parsed.msg ?? parsed.message ?? "no message"}`);
  }
  return parsed.data as T;
}

/** Session context for the workspace. `session_id` is required by confirm_upload. */
export async function fetchSession(): Promise<{ session_id?: string; workspace_id?: string; member_id?: string }> {
  return postJson("/file/welcome", { lang: "en_US" });
}

export async function requestUpload(filesize: number, fileType = "MP3"): Promise<PresignedUpload> {
  const data = await postJson<{ part_urls?: string[]; upload_id?: string; object_name?: string }>(
    "/file/get_upload_presigned_url",
    { filesize, file_type: fileType },
  );
  if (!data?.part_urls?.length || !data.upload_id || !data.object_name) {
    throw new UploadError("Plaud did not return a usable upload target.");
  }
  return { partUrls: data.part_urls, uploadId: data.upload_id, objectName: data.object_name };
}

/** PUT one part and return its ETag, which merge_multipart needs. */
export async function uploadPart(partUrl: string, partNumber: number, body: Buffer): Promise<UploadedPart> {
  const host = new URL(partUrl).host;
  if (!isAllowedHost(host)) {
    throw new UploadError(
      `Refusing to upload to ${host}: not in PLAUD_ALLOWED_HOSTS.`,
      `If Plaud has moved its bucket, add it:  PLAUD_ALLOWED_HOSTS=${config.allowedHosts.join(",")},${host}`,
    );
  }

  const res = await withNetworkErrors(host, () =>
    fetch(partUrl, {
      method: "PUT",
      body: new Uint8Array(body),
      // A part can be 5 MB over a slow uplink.
      signal: AbortSignal.timeout(Math.max(config.requestTimeoutMs, 600_000)),
    }),
  );

  if (!res.ok) {
    throw new UploadError(
      `Part ${partNumber} rejected by storage: HTTP ${res.status}`,
      res.status === 403 ? "Presigned upload URLs expire quickly. Start the upload again." : undefined,
    );
  }

  const etag = res.headers.get("etag");
  if (!etag) throw new UploadError(`Storage returned no ETag for part ${partNumber}; cannot reassemble.`);
  return { Etag: etag.replace(/"/g, ""), PartNumber: partNumber };
}

export async function mergeParts(uploadId: string, objectName: string, parts: UploadedPart[]): Promise<void> {
  await postJson("/file/merge_multipart", { upload_id: uploadId, object_name: objectName, parts });
}

export interface ConfirmOptions {
  uploadId: string;
  objectName: string;
  /** Shown in Plaud. Sent without a file extension, as the web app does. */
  filename: string;
  /** Epoch ms. This is what dates the recording — pass the ORIGINAL meeting time. */
  startTime: number;
  sessionId: string;
  fileType?: string;
}

export async function confirmUpload(opts: ConfirmOptions): Promise<ConfirmedFile> {
  return postJson<ConfirmedFile>("/file/confirm_upload", {
    upload_id: opts.uploadId,
    object_name: opts.objectName,
    scene: 101,
    is_tmp: 0,
    support_mul_summ: true,
    file_type: opts.fileType ?? "MP3",
    filename: opts.filename.replace(/\.[a-z0-9]{1,5}$/i, ""),
    start_time: opts.startTime,
    session_id: opts.sessionId,
    // 36 chars in the observed request, i.e. a UUID. Nothing ties it to hardware.
    serial_number: randomUUID(),
    timezone: utcOffsetHours(),
  });
}
