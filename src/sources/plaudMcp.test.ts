import assert from "node:assert/strict";
import { test } from "node:test";
import { FakePlaud, fakeRecording, fullArtifacts } from "../testing/fakePlaud.js";
import { childEnv, classifyToolError, normalizeTimestamp, stripSecrets, unwrapUntrusted } from "./plaudMcp.js";
import { AuthError } from "./types.js";

// P0-PLAN T5 (FR2, F8) — against the fake MCP server (T6).

test("unwrapUntrusted takes only the payload between the exact tags", () => {
  const t = 'The block delimited by <untrusted-user-data-abcd1234> below…\n<untrusted-user-data-abcd1234 source="plaud-recording">\n{"a":"</untrusted-user-data-0000>"}\n</untrusted-user-data-abcd1234>\ntrailer';
  assert.equal(unwrapUntrusted(t), '{"a":"</untrusted-user-data-0000>"}');
  assert.equal(unwrapUntrusted("Block not available"), null);
});

test("timestamps: zone-less is UTC; epoch seconds and ms accepted", () => {
  assert.equal(normalizeTimestamp("2026-11-03T15:00:00"), "2026-11-03T15:00:00.000Z");
  assert.equal(normalizeTimestamp("2026-11-03T15:00:00+02:00"), "2026-11-03T13:00:00.000Z");
  assert.equal(normalizeTimestamp(1_762_182_000), "2025-11-03T15:00:00.000Z");
  assert.equal(normalizeTimestamp(1_762_182_000_000), "2025-11-03T15:00:00.000Z");
  assert.equal(normalizeTimestamp("garbage"), null);
});

test("presigned links are stripped from anything persisted", () => {
  assert.deepEqual(stripSecrets({ a: 1, presigned_url: "u", list: [{ data_link: "l", data_type: "t" }] }), { a: 1, list: [{ data_type: "t" }] });
});

test("error classification", () => {
  assert.equal(classifyToolError("Failed: Not authenticated. Please login first."), "auth");
  assert.equal(classifyToolError("Token refresh failed: 400"), "auth");
  assert.equal(classifyToolError("API error: 429 Too Many Requests"), "rate");
  assert.equal(classifyToolError("API error: 502 Bad Gateway"), "retry");
  assert.equal(classifyToolError("API error: 404 Not Found"), "fatal");
});

test("child env: telemetry off, no PlaudPort secrets or API base leak into the package", async () => {
  const env = childEnv({ PATH: "/bin", HOME: "/h", PLAUD_API_BASE: "https://x", PLAUD_TOKEN: "t", HTTPS_PROXY: "http://p" });
  assert.equal(env.PLAUD_TELEMETRY_DISABLED, "1");
  assert.equal(env.PLAUD_API_BASE, undefined);
  assert.equal(env.PLAUD_TOKEN, undefined);
  assert.equal(env.HTTPS_PROXY, "http://p");

  const fake = new FakePlaud({ recordings: [] });
  const src = await fake.open({ ...process.env, PLAUD_API_BASE: "https://leak.example", PLAUD_TOKEN: "secret-ish" });
  try {
    const who = JSON.parse(await src.callTool("get_current_user", {}));
    assert.equal(who.telemetryDisabled, "1", "telemetry disabled on spawn");
    assert.deepEqual(who.leakedPlaudEnv, [], "no PLAUD_* besides the telemetry switch");
  } finally {
    await src.close();
  }
});

test("list pages through a date-filtered set; detail and text with cursor pages", async () => {
  const recs = Array.from({ length: 25 }, (_, i) =>
    fakeRecording(i + 1, new Date(Date.UTC(2026, 10, 1 + (i % 5), 9 + Math.floor(i / 5))).toISOString().replace(".000Z", "")),
  );
  const longTranscript = Array.from({ length: 1234 }, (_, i) => ({ speaker: "S", content: `line ${i}` }));
  recs[0]!.artifacts = { ...fullArtifacts(), transcript: { items: longTranscript } };
  const fake = new FakePlaud({ recordings: recs });
  const src = await fake.open();
  try {
    const p1 = await src.list({ from: "2026-11-01", to: "2026-11-05" }, { page: 1, pageSize: 10 });
    const p2 = await src.list({ from: "2026-11-01", to: "2026-11-05" }, { page: 2, pageSize: 10 });
    const p3 = await src.list({ from: "2026-11-01", to: "2026-11-05" }, { page: 3, pageSize: 10 });
    assert.equal(p1.length + p2.length + p3.length, 25);
    assert.equal(new Set([...p1, ...p2, ...p3].map((r) => r.id)).size, 25, "pages are distinct");
    assert.ok(p1.every((r) => r.startAt.endsWith("Z")));
    const narrow = await src.list({ from: "2026-11-02", to: "2026-11-02" }, { page: 1, pageSize: 100 });
    assert.equal(narrow.length, 5);

    const d = await src.detail(recs[0]!.id);
    assert.ok(d.audioUrl?.startsWith("http://127.0.0.1:"));
    assert.equal((d.rawDetail as Record<string, unknown>).presigned_url, undefined);

    const t = await src.text(recs[0]!.id);
    const tx = t.transcript.find((b) => b.block === "transaction")!;
    assert.equal(tx.items.length, 1234, "all cursor pages collected");
    assert.equal(t.transcript.find((b) => b.block === "mark_memo")!.status, "empty");
    assert.equal(t.note?.length, 1);
  } finally {
    await src.close();
  }
});

test("an artifact not yet produced reads as unavailable", async () => {
  const r = fakeRecording(1, "2026-11-01T09:00:00Z", { artifacts: { ...fullArtifacts(), note: { after: 5, items: [{ data_content: "x" }] }, outline: null } });
  const fake = new FakePlaud({ recordings: [r] });
  const src = await fake.open();
  try {
    const t = await src.text(r.id);
    assert.equal(t.transcript.find((b) => b.block === "outline")!.status, "unavailable");
    assert.deepEqual(t.note, []);
  } finally {
    await src.close();
  }
});

test("auth errors map to one AuthError carrying the login instruction", async () => {
  const fake = new FakePlaud({ auth: "logged_out", recordings: [] });
  const src = await fake.open();
  try {
    await assert.rejects(() => src.list({ from: "2026-11-01", to: "2026-11-02" }, { page: 1, pageSize: 10 }), (e: unknown) => {
      assert.ok(e instanceof AuthError);
      assert.match((e as Error).message, /plaudport login/);
      return true;
    });
    const h = await src.health();
    assert.equal(h.ok, false);
  } finally {
    await src.close();
  }
});

test("429s are retried with backoff and counted", async () => {
  const fake = new FakePlaud({ rateLimitCalls: 2, recordings: [fakeRecording(1, "2026-11-01T09:00:00Z")] });
  const src = await fake.open();
  try {
    const r = await src.list({ from: "2026-11-01", to: "2026-11-01" }, { page: 1, pageSize: 10 });
    assert.equal(r.length, 1);
    assert.equal(src.stats().rateLimited, 2);
    assert.equal(src.stats().requests, 3);
  } finally {
    await src.close();
  }
});
