import { VERSION } from "../src/version.ts";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
  throw new Error("Long timing smoke only permits local loopback HTTP endpoints");
}
const ms = 90_000;
const timeout = 120_000;
let requests = 0;
const client = new Client({ name: "sleep-mcp-long-smoke", version: VERSION }, {
  versionNegotiation: { mode: { pin: "2026-07-28" } },
});
const tracedFetch: typeof fetch = (input, init) => { requests++; return fetch(input, init); };
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: tracedFetch }), { timeout: 5_000 });
  await client.listTools({}, { timeout: 5_000 });
  const started = performance.now();
  const result = await client.callTool({ name: "sleep", arguments: { ms } }, { timeout, maxTotalTimeout: timeout });
  const clientElapsedMs = performance.now() - started;
  assert.ok(!result.isError, JSON.stringify(result.content));
  const data = result.structuredContent as Record<string, unknown>;
  assert.ok(data);
  assert.equal(data.requested_duration_ms, ms);
  assert.equal(data.actual_elapsed_ms, Number(data.end_epoch_ms) - Number(data.start_epoch_ms));
  assert.ok(Number(data.actual_elapsed_ms) >= ms);
  assert.ok(clientElapsedMs >= ms && clientElapsedMs < timeout);
  console.log(JSON.stringify({ passed: true, endpoint: endpoint.toString(), clientTimeoutMs: timeout,
    clientElapsedMs: Math.round(clientElapsedMs), result: data, totalHttpRequests: requests,
    scope: "A real local workerd call beyond the SDK default 60-second timeout, using an explicit timeout. Does not establish production one-hour availability or CPU compliance.",
  }, null, 2));
} finally { await client.close(); }
