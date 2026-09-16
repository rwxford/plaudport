/**
 * Editing .env in place.
 *
 * Refreshing an expiring credential by hand — open the file, find the line,
 * replace the value, save — is the kind of chore that makes a tool feel worse
 * than doing it manually. `set:auth` writes the line instead, and this is the
 * part that must not damage the rest of the file.
 */

/**
 * Replace `KEY=`'s value, or append the line if the key is absent.
 * Comments, blank lines, ordering and every other key are preserved exactly.
 */
export function upsertEnvLine(contents: string, key: string, value: string): string {
  const lines = contents.split("\n");
  const pattern = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  let replaced = false;

  const updated = lines.map((line) => {
    if (replaced || !pattern.test(line)) return line;
    replaced = true;
    return `${key}=${value}`;
  });

  if (replaced) return updated.join("\n");

  // Append, keeping exactly one trailing newline.
  const body = contents.replace(/\n+$/, "");
  return (body ? `${body}\n` : "") + `${key}=${value}\n`;
}
