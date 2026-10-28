import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

// A stand-in that answers the share endpoint with a Plaud-style error body,
// started before shareClient is imported so config picks up its address.
let server: Server;
let mod: typeof import("./shareClient.js");

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // HTTP 200, but Plaud's application status says "not found", with a message.
    res.end(JSON.stringify({ status: 40400, message: "share not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  process.env.PLAUD_ALLOWED_HOSTS = "127.0.0.1";
  process.env.PLAUD_SHARE_API_BASE = `http://127.0.0.1:${port}`;
  mod = await import("./shareClient.js");
});

after(() => server?.close());

test("a non-zero application status surfaces Plaud's own message and body", async () => {
  const ref = {
    shareId: "pub_00000000-0000-4000-8000-000000000000",
    accessToken: "sometoken1234",
    url: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::sometoken1234",
    host: "web.plaud.ai",
  };
  await assert.rejects(mod.fetchShareDetail(ref), (e: unknown) => {
    assert.ok(e instanceof mod.ShareApiError);
    assert.match(e.message, /40400/);
    assert.match(e.message, /share not found/); // Plaud's message, not just the code
    assert.match(String(e.hint ?? ""), /Full response:.*40400/s);
    return true;
  });
});
