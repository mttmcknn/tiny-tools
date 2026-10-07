import { McpServer } from "@modelcontextprotocol/server";
import type { ClockRuntime } from "./clock.ts";
import type { Toolset } from "./config.ts";
import { registerSleepTools } from "../tools/sleep/index.ts";
import { registerRandomTools } from "../tools/random/index.ts";

const SLEEP_INSTRUCTIONS = "Use current_time for the server's observed UTC/epoch clock. sleep waits asynchronously, reports actual elapsed wall time, and is bounded. Timers, client timeouts, and disconnection can interrupt a wait. This clock is not a precision or independent time-certification service.";
const RANDOM_INSTRUCTIONS = "Generate bounded, reproducible pseudorandom numbers from an explicit seed. Results are deterministic and are unsuitable for cryptography or security.";
const INSTRUCTIONS: Record<Toolset, string> = {
  sleep: SLEEP_INSTRUCTIONS,
  random: RANDOM_INSTRUCTIONS,
  tinytools: `${SLEEP_INSTRUCTIONS} ${RANDOM_INSTRUCTIONS}`,
};

// Each deployment selects its tool inventory while sharing protocol plumbing.
export function createServer(runtime: ClockRuntime, maxSleepMs: number, toolset: Toolset = "sleep") {
  const name = toolset === "tinytools" ? "tiny-tools-mcp" : `${toolset}-mcp`;
  const server = new McpServer({ name, version: "1.0.0" }, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS[toolset],
  });
  if (toolset === "sleep" || toolset === "tinytools") registerSleepTools(server, runtime, maxSleepMs);
  if (toolset === "random" || toolset === "tinytools") registerRandomTools(server);
  return server;
}
