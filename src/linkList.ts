/**
 * Reading a list of share links from a file.
 *
 * Kept apart from the batch CLI so it can be tested without importing a module
 * whose top level runs a command — and so the list format stays a documented
 * thing in its own right rather than an implementation detail of one script.
 */
export function parseLinkList(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    // Tolerate "1. <url>" or "- <url>" from a pasted list.
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim());
}
