import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// All requests are intercepted; no real credentials or Plaud endpoints are used.
test("confirmation requires a recording ID and uncertain results block duplicate retries", async () => {
  process.env.PLAUD_USER_TOKEN = "fictional-user-token";
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  process.env.PLAUD_AUTH = `fictional.${payload}.signature`;
  process.env.PLAUD_COOKIE = "fictional-cookie";
  process.env.PLAUD_DEVICE_ID = "fictional-device";
  const { importArchive } = await import("./importer.js");
  const dir = mkdtempSync(join(tmpdir(), "plaudport-confirm-"));
  const originalFetch = globalThis.fetch;
  let confirms = 0;
  let reply: unknown = {};
  let disconnect = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("get_upload_presigned_url")) return Response.json({ status: 0, data: {
      part_urls: ["https://api.plaud.ai/fictional-storage"], upload_id: "fictional-upload", object_name: "fictional-object",
    } });
    if (url.endsWith("fictional-storage")) return new Response(null, { headers: { etag: "fictional-etag" } });
    if (url.endsWith("confirm_upload")) {
      confirms++;
      assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).importConfirmationPending, true);
      if (disconnect) throw new TypeError("fictional lost response");
      return Response.json({ status: 0, data: reply });
    }
    if (url.endsWith("merge_multipart")) return Response.json({ status: 0, data: {} });
    throw Error("Unexpected request in fixture");
  };
  try {
    writeFileSync(join(dir, "audio.mp3"), "fictional audio bytes");
    const opts = { audioPath: join(dir, "audio.mp3"), title: "Fictional meeting", startTime: 1, shareDir: dir };
    writeFileSync(join(dir, "manifest.json"), "{}");
    await assert.rejects(importArchive(opts), /did not return a recording ID/);
    await assert.rejects(importArchive(opts), /Automatic retry is blocked/);
    await assert.rejects(importArchive({ ...opts, extraCopy: true }), /Automatic retry is blocked/);
    assert.equal(confirms, 1);

    writeFileSync(join(dir, "manifest.json"), "{}");
    disconnect = true;
    await assert.rejects(importArchive(opts), /Could not reach/);
    await assert.rejects(importArchive(opts), /Automatic retry is blocked/);
    assert.equal(confirms, 2);

    writeFileSync(join(dir, "manifest.json"), "{}");
    disconnect = false;
    reply = { id: "fictional-recording" };
    assert.equal((await importArchive(opts)).status, "imported");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.importedFileId, "fictional-recording");
    assert.equal(manifest.importConfirmationPending, undefined);
    assert.equal((await importArchive(opts)).status, "already-imported");
    assert.equal(confirms, 3);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
