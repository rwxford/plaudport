import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePipelineSettings, type PipelineConfig } from "../config.js";
import { runPull } from "../pull/pull.js";
import { FakePlaud, fakeRecording } from "../testing/fakePlaud.js";
import { tempRoot } from "../testing/fixtures.js";
import { g3bFinish, g3bStart } from "./g3b.js";

// The G3b helper itself, on the fake (class a). The live run is class b.

test("g3b: a kept URL past expiry is refused; a refreshed one downloads the archived bytes", async () => {
  const fake = new FakePlaud({ urlTtlSec: 1, recordings: [fakeRecording(1, "2026-11-04T09:00:00")] });
  const root = tempRoot("archive");
  const p = parsePipelineSettings({ PLAUDPORT_ARCHIVE_ROOT: root });
  const cfg = (p.ok ? p.config : null) as PipelineConfig;
  const allow = (h: string) => h.startsWith("127.0.0.1");
  await runPull({ since: "2026-11-01" }, { cfg, openSource: () => fake.open(), isAllowedHost: allow, log: () => {} });

  const src = await fake.open();
  try {
    await g3bStart(root, src);
    const kept = join(root, ".plaudport", "gate", "g3b.json");
    assert.ok(existsSync(kept));
    await assert.rejects(() => g3bFinish(root, src, { isAllowedHost: allow }), /run finish after/);
    await new Promise((r) => setTimeout(r, 1200)); // let the 1 s URL expire
    const r = await g3bFinish(root, src, { isAllowedHost: allow, minAgeHours: 0 });
    assert.equal(r.staleStatus, 403);
    assert.equal(r.staleRefused, true);
    assert.equal(r.refreshedDownloaded, true);
    assert.equal(r.hashMatchesArchive, true);
    assert.equal(r.pass, true);
    assert.equal(existsSync(kept), false, "the kept URL is deleted");
  } finally {
    await src.close();
  }
});
