import { McpServer } from "@modelcontextprotocol/server";
import type { ClockRuntime } from "./clock.ts";
import type { Toolset } from "./config.ts";
import { VERSION } from "./version.ts";
import { deploymentTools, normalizeToolSelection, type ToolName } from "./tool-selection.ts";
import { registerCurrentTimeTool, registerSleepTool } from "../tools/sleep/index.ts";
import { registerRandomTools } from "../tools/random/index.ts";

const INSTRUCTIONS: Record<ToolName, string> = {
  current_time: "Use current_time for the server's observed UTC/epoch clock. This clock is not a precision or independent time-certification service.",
  sleep: "sleep waits asynchronously, reports actual elapsed wall time, and is bounded. Timers, client timeouts, and disconnection can interrupt a wait.",
  random_numbers: "Use random_numbers to generate bounded, reproducible pseudorandom numbers from an explicit seed. Results are deterministic and are unsuitable for cryptography or security.",
};

// Each deployment selects its tool inventory while sharing protocol plumbing.
export function createServer(runtime: ClockRuntime, maxSleepMs: number, toolset: Toolset = "sleep", selectedTools: readonly ToolName[] = deploymentTools(toolset)) {
  const tools = normalizeToolSelection(toolset, selectedTools);
  const name = toolset === "tinytools" ? "tiny-tools-mcp" : `${toolset}-mcp`;
  const server = new McpServer({ name, version: VERSION }, {
    capabilities: { tools: { listChanged: false } },
    instructions: tools.map((tool) => INSTRUCTIONS[tool]).join(" "),
  });
  if (tools.includes("current_time")) registerCurrentTimeTool(server, runtime, maxSleepMs);
  if (tools.includes("sleep")) registerSleepTool(server, runtime, maxSleepMs);
  if (tools.includes("random_numbers")) registerRandomTools(server);
  return server;
}
