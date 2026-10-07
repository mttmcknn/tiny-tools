import { VERSION } from "../src/version.ts";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
// Smoke makes a small fixed set of requests; remote use must be consciously requested.
if (!process.argv[2] && endpoint.hostname !== "127.0.0.1") throw new Error("Default smoke must be local");
const traces: { httpMethod: string; rpcMethod?: string; status: number; contentType: string | null }[] = [];
const tracedFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  let rpcMethod: string | undefined;
  if (request.method === "POST") {
    try { rpcMethod = (await request.clone().json() as { method?: string }).method; }
    catch { /* Preserve malformed request bytes for the server validation check. */ }
  }
  const response = await fetch(request);
  traces.push({ httpMethod: request.method, rpcMethod, status: response.status, contentType: response.headers.get("content-type") });
  return response;
};
function structured(result: CallToolResult) {
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.ok(result.structuredContent);
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent as Record<string, unknown>;
}
function makeClient(modern = false) {
  return new Client({ name: "sleep-mcp-smoke", version: VERSION }, {
    versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
  });
}

const legacy = makeClient();
let clockResult, sleepResult, clientElapsedMs;
try {
  await legacy.connect(new StreamableHTTPClientTransport(endpoint, { fetch: tracedFetch }), { timeout: 5_000 });
  assert.equal(legacy.getProtocolEra(), "legacy");
  const tools = await legacy.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["current_time", "sleep"]);
  assert.ok(tools.tools.every((tool) => tool.outputSchema));
  const before = Date.now();
  clockResult = structured(await legacy.callTool({ name: "current_time", arguments: {} }));
  const after = Date.now();
  assert.equal(Date.parse(String(clockResult.utc)), clockResult.epoch_ms);
  assert.equal(Number(clockResult.epoch_ms) / 1000, clockResult.epoch_seconds);
  assert.ok(Number(clockResult.epoch_ms) >= before - 2_000 && Number(clockResult.epoch_ms) <= after + 2_000);
  const started = performance.now();
  sleepResult = structured(await legacy.callTool({ name: "sleep", arguments: { ms: 1_234 } }, { timeout: 5_000, maxTotalTimeout: 5_000 }));
  clientElapsedMs = performance.now() - started;
  assert.equal(sleepResult.requested_duration_ms, 1_234);
  assert.equal(sleepResult.actual_elapsed_ms, Number(sleepResult.end_epoch_ms) - Number(sleepResult.start_epoch_ms));
  assert.equal(sleepResult.difference_ms, Number(sleepResult.actual_elapsed_ms) - 1_234);
  assert.ok(Number(sleepResult.actual_elapsed_ms) >= 1_234);
  assert.ok(clientElapsedMs >= 1_234 && clientElapsedMs < 5_000);
  assert.ok(Math.abs(clientElapsedMs - Number(sleepResult.actual_elapsed_ms)) < 1_000);
  structured(await legacy.callTool({ name: "sleep", arguments: { ms: 0 } }));
} finally {
  await legacy.close();
}
const legacyHttpRequests = traces.length;

// Send invalid input to the server directly, bypassing SDK client-side schema checks.
async function raw(body: string, extraHeaders: Record<string, string> = {}) {
  return tracedFetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extraHeaders }, body,
  });
}
async function rpcResult(response: Response): Promise<{ result: { isError: boolean }; error: { code: number } }> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data, text);
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}
for (const args of [{ ms: -1 }, { ms: 0.5 }, { ms: 3_600_001 }, { ms: "1" }, {}, { ms: 1, extra: true }]) {
  const response = await raw(JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "sleep", arguments: args } }));
  assert.equal(response.status, 200);
  assert.equal((await rpcResult(response)).result.isError, true);
}
const oversized = await raw(JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", padding: "x".repeat(9_000) }));
assert.equal(oversized.status, 413);
await oversized.body?.cancel();
const origin = await raw(JSON.stringify({ jsonrpc: "2.0", id: 92, method: "tools/list" }), { Origin: "https://untrusted.example" });
assert.equal(origin.status, 403);
await origin.body?.cancel();
const malformed = await raw("{");
assert.equal(malformed.status, 400);
assert.equal((await rpcResult(malformed)).error.code, -32700);
const method = await tracedFetch(endpoint, { method: "GET", headers: { Accept: "text/event-stream" } });
assert.equal(method.status, 405);
await method.body?.cancel();

const modern = makeClient(true);
let modernResult, cancellationElapsedMs, timeoutElapsedMs;
try {
  await modern.connect(new StreamableHTTPClientTransport(endpoint, { fetch: tracedFetch }), { timeout: 5_000 });
  assert.equal(modern.getProtocolEra(), "modern");
  const listed = await modern.listTools();
  assert.equal(listed.tools.length, 2);
  modernResult = structured(await modern.callTool({ name: "sleep", arguments: { ms: 100 } }, { timeout: 3_000 }));
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 150);
  const started = performance.now();
  try {
    await assert.rejects(modern.callTool({ name: "sleep", arguments: { ms: 2_000 } }, { signal: controller.signal, timeout: 3_000 }));
  } finally {
    clearTimeout(abortTimer);
  }
  cancellationElapsedMs = performance.now() - started;
  assert.ok(cancellationElapsedMs < 1_000);
  const timed = performance.now();
  await assert.rejects(modern.callTool({ name: "sleep", arguments: { ms: 2_000 } }, { timeout: 150, maxTotalTimeout: 150 }));
  timeoutElapsedMs = performance.now() - timed;
  assert.ok(timeoutElapsedMs < 1_000);
  structured(await modern.callTool({ name: "current_time", arguments: {} }));
} finally {
  await modern.close();
}
assert.ok(traces.some((trace) => trace.rpcMethod === "initialize"));
assert.ok(traces.some((trace) => trace.rpcMethod === "notifications/initialized"));
console.log(JSON.stringify({
  passed: true, endpoint: endpoint.toString(), observed_at_utc: new Date().toISOString(),
  legacyProtocol: "initialize + initialized + tools/list + tools/call", legacyHttpRequests,
  clockResult, sleepResult, clientElapsedMs: Math.round(clientElapsedMs!), modernResult,
  cancellationElapsedMs: Math.round(cancellationElapsedMs!), timeoutElapsedMs: Math.round(timeoutElapsedMs!),
  totalHttpRequests: traces.length, traces,
  scope: "Local workerd timing and protocol smoke; client abort/timeout observed. Server timer cleanup is covered by injected runtime tests. No production limits measured.",
}, null, 2));
