/**
 * Sample redaction for run reports.
 *
 * The whole point of the M0 spike is to learn the *shape* of Plaud's responses —
 * which keys exist, which are ids, which are timestamps. None of that requires
 * keeping the actual content, which is meeting audio metadata, titles, and
 * transcript text. So by default we keep keys and value shapes and throw the
 * strings away, which makes a report safe to read, diff, and (carefully) share.
 *
 * Set PLAUD_REDACT_SAMPLES=false to keep raw values for local debugging.
 */

const MAX_ARRAY_ITEMS = 3;
const MAX_DEPTH = 6;

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_DEPTH) return "<depth-limit>";

  switch (typeof value) {
    case "string":
      return `<string:${value.length}>`;
    case "number":
    case "boolean":
      // Kept: ids, sizes, durations, timestamps and flags are what you need to
      // map endpoints, and they are not content.
      return value;
    case "object":
      break;
    default:
      return `<${typeof value}>`;
  }

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(v, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...head, `<${value.length - MAX_ARRAY_ITEMS} more>`] : head;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

/**
 * Cap the serialized size of a sample without producing invalid JSON.
 * Returns the value untouched when it is already small enough.
 */
export function capSize(value: unknown, maxChars = 2000): unknown {
  const s = JSON.stringify(value) ?? "";
  if (s.length <= maxChars) return value;
  return { _truncated: true, _originalChars: s.length, preview: s.slice(0, maxChars) };
}
