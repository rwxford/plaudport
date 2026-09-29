import { isMediaPath } from "./localMedia.js";

/**
 * What `npm run import` was asked to do. Kept apart from the CLI so it can be
 * tested without running one.
 *
 * Every bare argument is one of three things, told apart without asking:
 *   - a share link              https://web.plaud.ai/s/pub_…::tok  (or bare pub_…::tok)
 *   - a recording on disk       anything with an audio/video extension
 *   - a file listing links      anything else that exists
 */

export type ImportEntry =
  | { kind: "link"; value: string }
  | { kind: "media"; value: string }
  | { kind: "list"; value: string };

export interface ImportArgs {
  entries: ImportEntry[];
  fetchOnly: boolean;
  extraCopy: boolean;
  title?: string;
  date?: string;
}

export class ImportArgsError extends Error {}

const SWITCHES = new Set(["--fetch-only", "--extra-copy", "--force"]);
const VALUED = new Set(["--title", "--date"]);

export function looksLikeLink(arg: string): boolean {
  return /^https?:\/\//i.test(arg) || arg.includes("::");
}

export function parseImportArgs(argv: string[], fileExists: (path: string) => boolean): ImportArgs {
  const out: ImportArgs = { entries: [], fetchOnly: false, extraCopy: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      if (SWITCHES.has(flag)) {
        if (flag === "--fetch-only") out.fetchOnly = true;
        else out.extraCopy = true; // --force is what people reach for
        continue;
      }
      if (VALUED.has(flag)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith("--")) throw new ImportArgsError(`${flag} needs a value.`);
        if (flag === "--title") out.title = value;
        else out.date = value;
        continue;
      }
      throw new ImportArgsError(`Unknown option ${flag}.`);
    }

    if (looksLikeLink(arg)) out.entries.push({ kind: "link", value: arg });
    else if (!fileExists(arg)) {
      throw new ImportArgsError(
        isMediaPath(arg) ? `No such file: ${arg}` : `Not a share link, and no such file: ${arg}`,
      );
    } else out.entries.push({ kind: isMediaPath(arg) ? "media" : "list", value: arg });
  }

  if ((out.title !== undefined || out.date !== undefined) && !(out.entries.length === 1 && out.entries[0]!.kind === "media")) {
    throw new ImportArgsError(
      "--title and --date describe one recording, so they need exactly one audio/video file and nothing else.\n" +
        "Share links bring their own title and date; for several files, run one per file.",
    );
  }
  return out;
}
