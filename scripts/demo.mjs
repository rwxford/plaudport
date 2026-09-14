#!/usr/bin/env node
/**
 * End-to-end self-test:  npm run demo
 *
 * Stands up a fake "share page" on your own machine that serves a real audio
 * file, writes the kind of browser recording (HAR) you'd capture from Plaud,
 * then runs the actual tools — scan:har and fetch:audio — against it and checks
 * the downloaded bytes are identical to what was served.
 *
 * If this passes, the machinery works on your machine and the only unknown left
 * is Plaud's real page. No Plaud account, no login, no network access needed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const ROOT = process.cwd();
const DEMO_DIR = join(ROOT, "data", "demo");
const OUT_NAME = "demo-recording.wav";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};

/** Two seconds of a 440 Hz tone as a real .wav — so the result actually plays. */
function makeWav({ seconds = 2, rate = 22050, freq = 440 } = {}) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, Math.min(i, samples - i) / (rate * 0.05)); // avoid clicks
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * fade), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function main() {
  console.log("\n=== PlaudPort self-test ===\n");
  console.log(`Node ${process.version}`);
  if (Number(process.version.slice(1).split(".")[0]) < 20) {
    check(false, "Node 20 or newer", `you have ${process.version}`);
  } else {
    check(true, "Node version");
  }
  check(existsSync(join(ROOT, "node_modules")), "dependencies installed", "run: npm install");
  if (failures) process.exit(1);

  rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true });

  const audio = makeWav();
  const expected = createHash("sha256").update(audio).digest("hex");

  // A stand-in for Plaud's public share API, shaped like the real one
  // (recorded 2026-09-14 — see docs/SHARE-API.md).
  const SHARE_ID = "pub_00000000-0000-4000-8000-000000000000";
  const SHARE_TOKEN = "demo-token-not-a-real-one-0123456789";
  const detail = {
    status: 0,
    object_type: "file",
    owner_name: "Demo Owner",
    is_audio: 1,
    is_trans: 1,
    is_ai_content: 1,
    data_file: {
      id: "0".repeat(32),
      filename: "Demo meeting — self-test",
      start_time: 1789402715000,
      duration: 2000,
      file_language: "en",
      trans_result: [
        { start_time: 0, end_time: 1000, speaker: "Alex", content: "First line of the demo transcript." },
        { start_time: 1000, end_time: 2000, speaker: "Sam", content: "Second line." },
      ],
      transaction_polish: [{ start_time: 0, end_time: 2000, speaker: "Alex", content: "A polished line." }],
      outline_result: [{ start_time: 0, end_time: 2000, topic: "Demo topic" }],
      notes_list: [{ data_title: "Summary", data_content: "A demo summary." }],
    },
  };

  let audioLinkRequests = 0;
  let port = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/media/recording.wav")) {
      res.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length });
      res.end(audio);
    } else if (url.includes("/share/access/") && url.endsWith("/audio")) {
      audioLinkRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 0, temp_url: `http://127.0.0.1:${port}/media/recording.wav?signature=pretend` }));
    } else if (url.includes("/share/access/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(detail));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  console.log(`\nFake share server on 127.0.0.1:${port}, serving ${(audio.length / 1024).toFixed(0)} KB of audio\n`);

  // 2. the browser recording you would capture from the real page
  const harPath = join(DEMO_DIR, "demo.har");
  writeFileSync(
    harPath,
    JSON.stringify({
      log: {
        entries: [
          {
            _resourceType: "xhr",
            request: { method: "GET", url: `http://127.0.0.1:${port}/api/share/detail?id=pub_demo`, headers: [], queryString: [] },
            response: { status: 200, content: { mimeType: "application/json", text: '{"title":"Demo meeting","transcript":[{"speaker":"A","text":"hello"}]}' } },
          },
          {
            _resourceType: "media",
            request: { method: "GET", url: `http://127.0.0.1:${port}/media/recording.wav?signature=pretend-signed-url`, headers: [], queryString: [] },
            response: { status: 200, content: { mimeType: "audio/wav", size: audio.length } },
          },
          {
            _resourceType: "script",
            request: { method: "GET", url: `http://127.0.0.1:${port}/assets/app.js`, headers: [], queryString: [] },
            response: { status: 200, content: { mimeType: "text/javascript", text: "noise" } },
          },
        ],
      },
    }),
  );

  const env = { PLAUD_ALLOWED_HOSTS: "127.0.0.1", PLAUD_DATA_DIR: DEMO_DIR };

  // 3. find the audio in that recording
  console.log("Step 1: finding the audio in the browser recording…");
  const scan = await run(["src/harScan.ts", harPath], env);
  check(scan.code === 0, "scan:har ran");
  check(/Audio \/ media requests \(1\)/.test(scan.out), "found exactly one audio request");
  check(!scan.out.includes("pretend-signed-url"), "did not print the signed URL to the screen");

  const scanJson = JSON.parse(readFileSync(join(DEMO_DIR, "har-scan.json"), "utf8"));
  check(scanJson.mediaRequests?.[0]?.url?.includes("pretend-signed-url"), "kept the full URL locally so the download works");

  // 4. download it
  console.log("\nStep 2: downloading it…");
  const fetched = await run(["src/fetchAudio.ts", "--from-scan", "--out", OUT_NAME], env);
  check(fetched.code === 0, "fetch:audio ran");

  const outPath = join(DEMO_DIR, "shares", OUT_NAME);
  const ok = check(existsSync(outPath), "audio file saved");
  if (ok) {
    const got = createHash("sha256").update(readFileSync(outPath)).digest("hex");
    check(got === expected, "downloaded bytes identical to what was served");
    const manifest = JSON.parse(readFileSync(`${outPath}.json`, "utf8"));
    check(manifest.sha256 === got, "checksum recorded correctly");
    check(manifest.bytes === audio.length, "size recorded correctly");
  }

  // 5. the real thing: fetch:share against the stand-in API
  console.log("\nStep 3: fetching a share end to end (metadata + transcript + audio)…");
  const shareEnv = {
    PLAUD_ALLOWED_HOSTS: "127.0.0.1",
    PLAUD_DATA_DIR: DEMO_DIR,
    PLAUD_SHARE_API_BASE: `http://127.0.0.1:${port}`,
  };
  const share = await run(["src/shareFetch.ts", `${SHARE_ID}::${SHARE_TOKEN}`], shareEnv);
  check(share.code === 0, "fetch:share ran");
  check(/2 utterances/.test(share.out), "read the transcript from the API");

  const shareDir = join(DEMO_DIR, "shares", `${SHARE_ID}-demo-meeting-self-test`);
  const transcript = existsSync(join(shareDir, "transcript.txt"))
    ? readFileSync(join(shareDir, "transcript.txt"), "utf8")
    : "";
  check(/\[0:00\] Alex: First line/.test(transcript), "wrote a readable transcript");
  check(existsSync(join(shareDir, "recording.md")), "wrote the markdown archive");

  const shareAudio = join(shareDir, "audio.mp3");
  if (check(existsSync(shareAudio), "downloaded the share's audio")) {
    const got = createHash("sha256").update(readFileSync(shareAudio)).digest("hex");
    check(got === expected, "share audio matches what the API served");
  }

  const again = await run(["src/shareFetch.ts", `${SHARE_ID}::${SHARE_TOKEN}`], shareEnv);
  check(/already archived/.test(again.out), "re-running skips the download instead of duplicating");
  check(audioLinkRequests === 1, "asked for the audio link exactly once across both runs");

  // 6. guards
  console.log("\nStep 4: checking the safety guards…");
  const badHost = await run(["src/fetchAudio.ts", `http://127.0.0.1:${port}/media/recording.wav`], {
    PLAUD_DATA_DIR: DEMO_DIR,
  });
  check(badHost.code !== 0 && /not in PLAUD_ALLOWED_HOSTS/.test(badHost.out), "refuses hosts that aren't allowlisted");

  // Note: the default allowlist, not the demo's — otherwise the host guard fires
  // first and we never exercise the link parser.
  const badLink = await run(["src/shareProbe.ts", "https://web.plaud.ai/s/nonsense"], { PLAUD_DATA_DIR: DEMO_DIR });
  check(badLink.code !== 0 && /separator/.test(badLink.out), "rejects a malformed share link");

  const wrongSite = await run(["src/shareProbe.ts", "https://evil.example.com/s/pub_x::y"], { PLAUD_DATA_DIR: DEMO_DIR });
  check(wrongSite.code !== 0 && /not in PLAUD_ALLOWED_HOSTS/.test(wrongSite.out), "refuses a link to a non-Plaud site");

  server.close();

  console.log("\n" + "=".repeat(48));
  if (failures === 0) {
    console.log("ALL CHECKS PASSED.");
    console.log(`\nPlay the file it produced — it should be a 2-second tone:`);
    console.log(`  open "${outPath}"`);
    console.log(`\nThat file arrived exactly the way a real Plaud recording will:`);
    console.log(`browser recording -> find the audio -> download -> verify.`);
    console.log(`\nClean up when you're done:  rm -rf data/demo`);
  } else {
    console.log(`${failures} CHECK(S) FAILED — send me the output above.`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
