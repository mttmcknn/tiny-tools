import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CLOCK_SOURCE, currentTime, sleep, type ClockRuntime } from "../../src/clock.ts";

const currentTimeOutput = z.object({
  utc: z.string(),
  epoch_ms: z.number().int(),
  epoch_seconds: z.number(),
  clock_source: z.literal(CLOCK_SOURCE),
  max_sleep_ms: z.number().int(),
});
const sleepOutput = z.object({
  status: z.enum(["completed", "timer_returned_early", "clock_moved_backwards", "cancelled"]),
  started_at_utc: z.string(),
  ended_at_utc: z.string(),
  start_epoch_ms: z.number().int(),
  end_epoch_ms: z.number().int(),
  requested_duration_ms: z.number().int(),
  actual_elapsed_ms: z.number().int(),
  difference_ms: z.number().int(),
  clock_source: z.literal(CLOCK_SOURCE),
});

function result(data: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

// Schemas can be shared, but the SDK factory creates a fresh server per HTTP request.
export function registerSleepTools(server: McpServer, runtime: ClockRuntime, maxSleepMs: number) {
  server.registerTool("current_time", {
    description: "Return the server runtime's current UTC ISO timestamp and Unix epoch milliseconds/seconds. The observation uses Date.now at the last runtime I/O event; accuracy and network latency are not guaranteed. Also reports the configured sleep cap.",
    inputSchema: z.object({}).strict(),
    outputSchema: currentTimeOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => result(currentTime(runtime, maxSleepMs)));

  server.registerTool("sleep", {
    description: `Wait asynchronously for an integer duration in milliseconds from 0 through ${maxSleepMs}. Return server UTC/epoch start/end observations, requested duration, measured elapsed wall time, and difference. Scheduling may overshoot or return early; inspect status. Set your client timeout above this delay. Cancellation/disconnect may prevent a response.`,
    inputSchema: z.object({ ms: z.number().int().min(0).max(maxSleepMs).describe("Requested wait in whole milliseconds") }).strict(),
    outputSchema: sleepOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ ms }, context) => {
    const data = await sleep(ms, runtime, context.mcpReq.signal);
    return result(data, data.status !== "completed");
  });
}
