import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
  throw new Error("This bounded load test only permits local loopback HTTP endpoints");
}
function bounded(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer ${min}..${max}`);
  return parsed;
}
const clients = bounded(process.argv[3], 16, 1, 32);
const callsPerClient = bounded(process.argv[4], 2, 1, 3);
const delayMs = bounded(process.argv[5], 250, 0, 1_000);
const counts: Record<string, number> = {};
let httpRequests = 0;
const tracedFetch: typeof fetch = async (input, init) => {
  if (++httpRequests > 256) throw new Error("Hard request budget exceeded (256)");
  const request = new Request(input, init);
  const method = request.method === "POST" ? (await request.clone().json() as { method: string }).method : request.method;
  counts[method] = (counts[method] ?? 0) + 1;
  return fetch(request);
};
const elapsed: number[] = [];
const clientWall: number[] = [];
const started = performance.now();
await Promise.all(Array.from({ length: clients }, async (_, index) => {
  const client = new Client({ name: `local-load-${index}`, version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: tracedFetch }), { timeout: 5_000 });
    await client.listTools({}, { timeout: 5_000 });
    for (let call = 0; call < callsPerClient; call++) {
      const before = performance.now();
      const result = await client.callTool({ name: "sleep", arguments: { ms: delayMs } }, { timeout: 5_000, maxTotalTimeout: 5_000 });
      assert.ok(!result.isError);
      assert.ok(result.structuredContent && typeof result.structuredContent === "object");
      const data = result.structuredContent as Record<string, unknown>;
      assert.equal(data.requested_duration_ms, delayMs);
      assert.equal(data.actual_elapsed_ms, Number(data.end_epoch_ms) - Number(data.start_epoch_ms));
      assert.ok(Number(data.actual_elapsed_ms) >= delayMs);
      elapsed.push(Number(data.actual_elapsed_ms));
      clientWall.push(performance.now() - before);
    }
  } finally {
    await client.close();
  }
}));
console.log(JSON.stringify({ passed: true, endpoint: endpoint.toString(), clients, callsPerClient, delayMs,
  completedCalls: elapsed.length, totalHttpRequests: httpRequests, requestCounts: counts,
  totalWallMs: Math.round(performance.now() - started),
  serverElapsedMinMs: Math.min(...elapsed), serverElapsedMaxMs: Math.max(...elapsed),
  clientCallWallMinMs: Math.round(Math.min(...clientWall)), clientCallWallMaxMs: Math.round(Math.max(...clientWall)),
  scope: "Bounded local workerd test; demonstrates independent concurrent waits, not deployed throughput or the Free CPU budget.",
}, null, 2));
