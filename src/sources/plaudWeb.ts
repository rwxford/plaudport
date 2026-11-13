import { NotImplemented, type RecordingSource } from "./types.js";

/**
 * `plaud-web` adapter (FR2). P0 ships a stub on purpose (P0-PLAN §5): the only
 * reason to build it is an outage of the official MCP, which has not happened,
 * and an untested second code path is worse than an honest error.
 */
export function createPlaudWebSource(): RecordingSource {
  const no = (): never => {
    throw new NotImplemented(
      "The plaud-web source is not implemented in P0; use plaud-mcp (the default). See docs/P0-PLAN.md §5.",
    );
  };
  return {
    name: "plaud-web",
    list: async () => no(),
    detail: async () => no(),
    text: async () => no(),
    health: async () => ({ ok: false, note: "plaud-web source not implemented (P0 stub)" }),
    stats: () => ({ requests: 0, rateLimited: 0, retries: 0 }),
    close: async () => {},
  };
}
