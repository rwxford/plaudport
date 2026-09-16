/**
 * Reading a JWT's expiry, locally.
 *
 * Plaud's Authorization bearer is a JWT, and a JWT carries its own expiry in a
 * base64url payload that anyone holding the token can read — no secret, no
 * network call, no verification involved. That is enough to say "this expired
 * two hours ago" before uploading nine megabytes to find out.
 *
 * This deliberately does NOT verify the signature: we are not authenticating
 * anything, only reading a timestamp the token states about itself.
 */

export interface TokenExpiry {
  expiresAt: Date;
  expired: boolean;
  /** Human phrasing: "in 3h 20m", "2h 5m ago". */
  relative: string;
}

function decodeSegment(segment: string): unknown {
  // base64url -> base64, then pad.
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function describeGap(ms: number): string {
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000) % 60;
  const hours = Math.floor(abs / 3_600_000) % 24;
  const days = Math.floor(abs / 86_400_000);
  const parts = [days ? `${days}d` : "", hours ? `${hours}h` : "", !days && minutes ? `${minutes}m` : ""].filter(Boolean);
  const text = parts.join(" ") || "under a minute";
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

/** Null when the value is not a JWT or carries no usable `exp`. */
export function readTokenExpiry(token: string, now = Date.now()): TokenExpiry | null {
  const bare = token.replace(/^bearer\s+/i, "").trim();
  const segments = bare.split(".");
  if (segments.length !== 3) return null;

  const payload = decodeSegment(segments[1] ?? "");
  const exp = (payload as { exp?: unknown } | null)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // `exp` is seconds since the epoch, per RFC 7519.
  const expiresAt = new Date(exp * 1000);
  const delta = expiresAt.getTime() - now;
  return { expiresAt, expired: delta <= 0, relative: describeGap(delta) };
}
