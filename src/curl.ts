/**
 * Parsing a "Copy as cURL" command from DevTools.
 *
 * A HAR export can be sanitized into uselessness, but "Copy as cURL" on a single
 * request always carries everything — which is the point and also the hazard:
 * the string holds live credentials. Parsing it locally means the interesting
 * part (which endpoint, which fields) can be shared without the values ever
 * leaving the machine.
 */

export interface ParsedCurl {
  method: string;
  url: string;
  headerNames: string[];
  /** Header values, kept for local inspection only — never printed wholesale. */
  headers: Record<string, string>;
  body?: string;
  hasCookie: boolean;
}

/** Split a shell-ish command into tokens, honouring single and double quotes. */
export function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    // A backslash-newline is a line continuation, not content.
    if (ch === "\\" && (input[i + 1] === "\n" || input[i + 1] === "\r")) {
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
  }
  if (current || started) tokens.push(current);
  return tokens;
}

export function parseCurl(command: string): ParsedCurl {
  const tokens = tokenizeShell(command.trim());
  if (tokens[0] !== "curl") throw new Error('That does not start with "curl" — use DevTools → right-click a request → Copy → Copy as cURL.');

  let url = "";
  let method = "";
  let body: string | undefined;
  const headers: Record<string, string> = {};
  let hasCookie = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = () => tokens[++i] ?? "";

    if (token === "-X" || token === "--request") {
      method = next().toUpperCase();
    } else if (token === "-H" || token === "--header") {
      const raw = next();
      const colon = raw.indexOf(":");
      if (colon > 0) {
        const name = raw.slice(0, colon).trim().toLowerCase();
        headers[name] = raw.slice(colon + 1).trim();
        if (name === "cookie") hasCookie = true;
      }
    } else if (token === "-b" || token === "--cookie") {
      headers["cookie"] = next();
      hasCookie = true;
    } else if (token === "--data-raw" || token === "--data" || token === "-d" || token === "--data-binary") {
      body = next();
    } else if (token === "--compressed" || token.startsWith("-")) {
      // Flags we don't care about; those taking a value are handled above.
      continue;
    } else if (!url) {
      url = token;
    }
  }

  if (!url) throw new Error("No URL found in that cURL command.");
  return { method: method || (body ? "POST" : "GET"), url, headerNames: Object.keys(headers), headers, hasCookie, body };
}
