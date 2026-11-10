import Database from "better-sqlite3";
import { requirePipelineConfig } from "./config.js";
import { defaultDoctorEnv, renderDoctor, runDoctor } from "./doctor.js";
import { installMcp } from "./pipelineRuntime.js";

/** plaudport doctor [--install-mcp] */

const cfg = requirePipelineConfig();
const argv = process.argv.slice(2);
if (argv.some((a) => a !== "--install-mcp")) {
  console.error("Usage: plaudport doctor [--install-mcp]");
  process.exit(1);
}
if (argv.includes("--install-mcp")) {
  const r = installMcp(cfg);
  console.log(r.detail + "\n");
  if (!r.ok) process.exit(1);
}
const native = () => {
  try {
    new Database(":memory:").prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
};
const result = runDoctor(defaultDoctorEnv(cfg, native));
console.log("PlaudPort doctor (P0 pull checks)\n");
console.log(renderDoctor(result));
process.exit(result.ok ? 0 : 1);
