import { isAllowedHost } from "./config.js";

/**
 * Parsing for Plaud public share links.
 *
 * Observed shape (2026-09):
 *   https://web.plaud.ai/s/pub_<uuid>::<access-token>
 *
 * The part before "::" identifies the shared item; the part after is a bearer-ish
 * access token that makes the link work without logging in. Both are needed to
 * fetch anything, and the token is sensitive in the same way the link is: anyone
 * holding it can read that meeting. Treat a share link like a password for that
 * one recording — don't commit it, don't log it in full.
 */

export interface ShareRef {
  /** e.g. "pub_b42cf8f6-fd60-44dc-a73d-af2d3c0bde18" */
  shareId: string;
  /** the opaque access token after "::" */
  accessToken: string;
  /** the full canonical https URL for the share page */
  url: string;
  /** host the link points at, lowercased */
  host: string;
}

export class ShareUrlError extends Error {}

const SHARE_ID = /^pub_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a full share URL, or a bare "pub_<uuid>::<token>" pair.
 * Throws ShareUrlError with a readable message rather than returning null, since
 * every caller is a CLI that should stop and say why.
 */
export function parseShareUrl(input: string): ShareRef {
  const raw = input.trim();
  if (!raw) throw new ShareUrlError("No share link given.");

  let host = "web.plaud.ai";
  let pathPart = raw;

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ShareUrlError(`Not a valid URL: ${raw}`);
    }
    host = url.host.toLowerCase();
    if (!isAllowedHost(host)) {
      throw new ShareUrlError(
        `Refusing to fetch ${host}: not in PLAUD_ALLOWED_HOSTS. A Plaud share link should be on web.plaud.ai.`,
      );
    }
    // /s/<id>::<token>  — take the last non-empty path segment
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) throw new ShareUrlError(`No share id found in the path of ${raw}`);
    pathPart = last;
  }

  // Browsers and chat clients often percent-encode the colons.
  const decoded = safeDecode(pathPart);
  const sep = decoded.indexOf("::");
  if (sep === -1) {
    throw new ShareUrlError(
      "Share link is missing the '::' separator between the share id and its access token.\n" +
        "Expected something like: https://web.plaud.ai/s/pub_<uuid>::<token>",
    );
  }

  const shareId = decoded.slice(0, sep);
  const accessToken = decoded.slice(sep + 2);

  if (!SHARE_ID.test(shareId)) {
    throw new ShareUrlError(`Share id doesn't look right: "${shareId}" (expected pub_<uuid>).`);
  }
  if (accessToken.length < 8) {
    throw new ShareUrlError("Share access token is missing or too short — the link may have been truncated.");
  }

  return {
    shareId,
    accessToken,
    url: `https://${host}/s/${shareId}::${accessToken}`,
    host,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A short, log-safe rendering of a share reference. Never prints the full token. */
export function describeShare(ref: ShareRef): string {
  const t = ref.accessToken;
  const masked = t.length <= 10 ? "…" : `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
  return `${ref.shareId} [token ${masked}]`;
}
