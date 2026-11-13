import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, createPlaudMcpSource } from "../sources/plaudMcp.js";
import { tempRoot } from "./fixtures.js";

/** Path to the fake server script (P0-PLAN T6). */
export const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "fake-plaud-mcp.mjs");

export interface FakeArtifact {
  after?: number;
  items: unknown[];
}
export interface FakeRecording {
  id: string;
  name: string;
  start_at: string;
  created_at: string;
  duration?: number;
  visibleFromRun?: number;
  audioFailures?: number;
  textError?: boolean;
  artifacts?: Partial<Record<"transcript" | "polish" | "outline" | "highlights" | "note", FakeArtifact | null>>;
}
export interface FakeFixture {
  auth?: "ok" | "logged_out";
  urlTtlSec?: number;
  rateLimitCalls?: number;
  expireFirstUrls?: number;
  generate?: { count: number; from: string; perDay?: number };
  recordings?: FakeRecording[];
}

export function fullArtifacts(after = 0): FakeRecording["artifacts"] {
  return {
    transcript: { after, items: [{ speaker: "Speaker 1", content: "synthetic line", start_time: 0 }] },
    polish: { after, items: [{ speaker: "Speaker 1", content: "Synthetic line.", start_time: 0 }] },
    outline: { after, items: [{ topic: "synthetic topic" }] },
    highlights: { after, items: [] },
    note: { after, items: [{ data_type: "auto_sum_note", data_content: "synthetic summary" }] },
  };
}

export function fakeRecording(n: number, startAt: string, extra: Partial<FakeRecording> = {}): FakeRecording {
  return {
    id: `of_fake${String(n).padStart(6, "0")}`,
    name: `Synthetic recording ${n}`,
    start_at: startAt,
    created_at: startAt,
    duration: 60_000,
    artifacts: fullArtifacts(),
    ...extra,
  };
}

export class FakePlaud {
  readonly dir: string;
  constructor(fixture: FakeFixture) {
    this.dir = tempRoot("fake-plaud");
    mkdirSync(this.dir, { recursive: true });
    this.set(fixture);
  }
  set(fixture: FakeFixture): void {
    writeFileSync(join(this.dir, "fixture.json"), JSON.stringify(fixture));
  }
  state(): { runs: number; calls: Record<string, number>; checks: Record<string, number> } {
    return JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8"));
  }
  /** Options to launch the fake as the plaud-mcp source. */
  sourceOptions(parentEnv: Record<string, string | undefined> = process.env) {
    return {
      command: process.execPath,
      args: [FAKE_SERVER],
      env: childEnv(parentEnv, { FAKE_PLAUD_DIR: this.dir }),
      minSpacingMs: 0,
      backoffBaseMs: 5,
    };
  }
  open(parentEnv?: Record<string, string | undefined>) {
    return createPlaudMcpSource(this.sourceOptions(parentEnv));
  }
}
