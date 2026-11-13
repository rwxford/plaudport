import { config, requirePipelineConfig } from "./config.js";
import { openMcpSource, SetupError } from "./pipelineRuntime.js";

/**
 * plaudport login — ask Plaud's own MCP package to run its OAuth sign-in
 * (P0-D2): it opens the browser and stores its refresh token in
 * ~/.plaud/tokens-mcp.json. PlaudPort never sees or stores the token.
 */

const cfg = requirePipelineConfig();
try {
  const src = await openMcpSource(cfg, config.requestTimeoutMs);
  try {
    console.log("Opening Plaud's sign-in in your browser (waits up to 2 minutes)…");
    const text = await src.callTool("login", {}, 150_000);
    console.log(text.trim());
  } finally {
    await src.close();
  }
  console.log("\nNext: `plaudport doctor`.");
} catch (e) {
  console.error(e instanceof SetupError ? e.message : `login failed: ${(e as Error).message}`);
  process.exit(1);
}
