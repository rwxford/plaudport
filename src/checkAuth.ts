import { getDeviceId } from "./config.js";
import { requestUpload, UploadError } from "./uploadClient.js";

/**
 * Check whether your Plaud credentials work, without uploading anything.
 *
 *   npm run check:auth
 *
 * Asks Plaud for an upload target for a 1 MB file and throws the answer away.
 * Nothing is stored in your workspace: an upload target that never receives
 * bytes and is never confirmed does not become a recording.
 *
 * Prints a fingerprint of the values it loaded — length and first/last few
 * characters — so you can compare against what DevTools shows without pasting
 * the credential anywhere.
 */

function fingerprint(value: string): string {
  if (!value) return "(not set)";
  if (value.length <= 8) return `${value.length} chars (too short to be right)`;
  return `${value.length} chars, ${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function main() {
  const token = (process.env.PLAUD_USER_TOKEN ?? "").trim();
  const rawToken = process.env.PLAUD_USER_TOKEN ?? "";

  console.log("\nCredentials as this tool loaded them:\n");
  console.log(`  PLAUD_USER_TOKEN  ${fingerprint(token)}`);
  console.log(`  PLAUD_DEVICE_ID   ${process.env.PLAUD_DEVICE_ID ? fingerprint(process.env.PLAUD_DEVICE_ID.trim()) : `(not set — using ${getDeviceId()})`}`);
  console.log(`  PLAUD_AUTH        ${process.env.PLAUD_AUTH ? fingerprint(process.env.PLAUD_AUTH.trim()) : "(not set)"}`);
  console.log(`  PLAUD_COOKIE      ${process.env.PLAUD_COOKIE ? "set" : "(not set)"}`);

  if (rawToken !== token) {
    console.log("\n  NOTE: the token had leading/trailing whitespace, which was trimmed.");
  }
  if (/\s/.test(token)) {
    console.log("\n  WARNING: the token contains a space. It was probably copied with something extra.");
  }

  console.log("\nCompare the first/last characters and the length against DevTools:");
  console.log("  web.plaud.ai → Network → any api.plaud.ai request → Request Headers → x-pld-user\n");

  try {
    await requestUpload(1_048_576);
    console.log("Authenticated. Plaud issued an upload target, which we discarded.");
    console.log("Nothing was added to your workspace — an unconfirmed upload never becomes a recording.");
  } catch (e) {
    if (e instanceof UploadError) {
      console.error(`Not working yet: ${e.message}`);
      if (e.hint) console.error(e.hint);
      console.error("\nIf the fingerprint above matches DevTools exactly, the token is not the problem.");
      console.error("Check a real api.plaud.ai/file/ request in DevTools > Request Headers for an");
      console.error("`authorization` or `cookie` header. Chrome's sanitized HAR export removes both,");
      console.error("so a capture can look credential-free when it was not. If one is there, set");
      console.error("PLAUD_AUTH or PLAUD_COOKIE in .env and run this again.");
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
