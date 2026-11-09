import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

// A stand-in for Plaud's share API, started before shareClient is imported so
// config picks up its address. It records every request path/headers, answers a
// success body for a normal link and a Plaud-style error body for the ":error"
// token, so one server covers both the happy path and the failure path.
let server: Server;
let mod: typeof import("./shareClient.js");
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").includes("::errortoken")) {
      // HTTP 200, but Plaud's application status says "not found", with a message.
      res.end(JSON.stringify({ status: 40400, message: "share not found" }));
    } else {
      res.end(JSON.stringify({ status: 0, object_type: "file", data_file: { id: "abc", filename: "t" } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  process.env.PLAUD_ALLOWED_HOSTS = "127.0.0.1";
  process.env.PLAUD_SHARE_API_BASE = `http://127.0.0.1:${port}`;
  mod = await import("./shareClient.js");
});

after(() => server?.close());

test("fetchShareDetail calls the versioned /share/v4/access/ endpoint", async () => {
  const ref = {
    shareId: "pub_00000000-0000-4000-8000-000000000000",
    accessToken: "goodtoken1234",
    url: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::goodtoken1234",
    host: "web.plaud.ai",
  };
  const detail = await mod.fetchShareDetail(ref);
  assert.equal(detail.status, 0);

  const req = seen.find((r) => r.url.includes("goodtoken1234"));
  assert.ok(req, `no request recorded; saw: ${seen.map((r) => r.url).join(", ")}`);
  // The path is the versioned one, carrying the <pub_id>::<token> reference.
  assert.equal(req.url, "/share/v4/access/pub_00000000-0000-4000-8000-000000000000::goodtoken1234");
  // Guard against a regression to the old, now-404ing unversioned path.
  assert.ok(!seen.some((r) => r.url.startsWith("/share/access/")), "must not call the old /share/access/ path");
  // The v4 web app sends the timezone as x-timezone-iana.
  assert.ok(req.headers["x-timezone-iana"], "x-timezone-iana header is sent");
});

test("a non-zero application status surfaces Plaud's own message and body", async () => {
  const ref = {
    shareId: "pub_00000000-0000-4000-8000-000000000000",
    accessToken: "errortoken",
    url: "https://web.plaud.ai/s/pub_00000000-0000-4000-8000-000000000000::errortoken",
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
