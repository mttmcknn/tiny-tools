import { VERSION } from "../src/version.ts";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";

// Bounded smoke for local workerd or an explicitly supplied deployed endpoint.
const [supplied, toolset, rootFlag] = process.argv.slice(2);
if (!supplied || !["sleep", "random", "tinytools"].includes(toolset ?? "") ||
    (rootFlag !== undefined && rootFlag !== "--check-root") || process.argv.length > 5) {
  throw new Error("Usage: node scripts/endpoint-smoke.ts URL/mcp[?tools=current_time,sleep,random_numbers] sleep|random|tinytools [--check-root]");
}
const endpoint = new URL(supplied);
const local = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
if ((!local && endpoint.protocol !== "https:") || endpoint.pathname !== "/mcp" ||
    endpoint.username || endpoint.password || endpoint.hash) {
  throw new Error("Supply a local HTTP or HTTPS /mcp URL without credentials or fragment");
}
// Derive the expected inventory independently of the server's selection resolver.
// Keep the full endpoint URL (including its query) for every SDK exchange.
const availableTools = toolset === "random" ? ["random_numbers"] : toolset === "sleep"
  ? ["current_time", "sleep"] : ["current_time", "sleep", "random_numbers"];
const filters = endpoint.searchParams.getAll("tools");
if (filters.length > 1) throw new Error("Supply at most one tools query parameter");
const requestedTools = filters.length === 0 ? availableTools : filters[0]!.split(",").map(name => name.trim());
if (requestedTools.some(name => !name || !availableTools.includes(name))) {
  throw new Error(`tools must select names available on ${toolset}: ${availableTools.join(",")}`);
}
const expectedTools = availableTools.filter(name => requestedTools.includes(name));
const excludedTools = availableTools.filter(name => !expectedTools.includes(name));
const hasCurrentTime = expectedTools.includes("current_time");
const hasSleep = expectedTools.includes("sleep");
const hasRandom = expectedTools.includes("random_numbers");
const identity = toolset === "tinytools" ? "tiny-tools-mcp" : `${toolset}-mcp`;
const observations: unknown[] = [];
const traces: { rpc?: string; method: string; status: number }[] = [];
let attempts = 0;
const suiteAbort = new AbortController();
const timer = setTimeout(() => suiteAbort.abort(new Error("Endpoint smoke exceeded 45 seconds")), 45_000);
const boundedFetch: typeof fetch = async (input, init) => {
  suiteAbort.signal.throwIfAborted();
  const request = new Request(input, init);
  if (request.url !== endpoint.href) throw new Error("Refusing MCP request to another endpoint");
  if (++attempts > 32) throw new Error("Endpoint smoke exceeded 32 HTTP attempts");
  const rpc = request.method === "POST" ? (await request.clone().json() as { method?: string }).method : undefined;
  const response = await fetch(request, { redirect: "error", signal: AbortSignal.any([request.signal, suiteAbort.signal]) });
  traces.push({ method: request.method, rpc, status: response.status });
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response;
};
function structured(result: CallToolResult) {
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.ok(result.structuredContent);
  const text = result.content.find(item => item.type === "text");
  assert.ok(text && text.type === "text");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}
try {
  for (const modern of [false, true]) {
    const client = new Client({ name: "tiny-tools-endpoint-smoke", version: VERSION }, {
      versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy", probe: { maxRetries: 0 } },
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, {
        fetch: boundedFetch, reconnectionOptions: {
          maxRetries: 0, maxReconnectionDelay: 1_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1,
        },
      }), { timeout: 10_000, maxTotalTimeout: 10_000, signal: suiteAbort.signal });
      assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
      assert.equal(client.getServerVersion()?.name, identity);
      const listed = await client.listTools({}, { timeout: 10_000, signal: suiteAbort.signal });
      assert.deepEqual(listed.tools.map(tool => tool.name), expectedTools);
      assert.ok(listed.tools.every(tool => tool.outputSchema));
      const observation: Record<string, unknown> = { protocol: client.getProtocolEra(), identity, server_version: client.getServerVersion()?.version, tools: expectedTools };
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, {
        timeout: 10_000, maxTotalTimeout: 10_000, signal: suiteAbort.signal,
      });
      if (hasCurrentTime) {
        const clock = structured(await call("current_time", {}));
        assert.equal(Date.parse(String(clock.utc)), clock.epoch_ms);
        observation.clock = clock;
      }
      if (hasSleep) {
        const started = performance.now();
        const slept = structured(await call("sleep", { ms: 100 }));
        assert.equal(slept.status, "completed");
        assert.equal(slept.requested_duration_ms, 100);
        assert.ok(Number(slept.actual_elapsed_ms) >= 100);
        observation.sleep = slept;
        observation.client_elapsed_ms = Math.round(performance.now() - started);
      }
      if (hasRandom) {
        const random = structured(await call("random_numbers", { seed: 42, count: 3 }));
        assert.deepEqual(random, { algorithm: "mulberry32", values: [0.6011037519201636, 0.44829055899754167, 0.8524657934904099], next_seed: 1199730185 });
        const next = structured(await call("random_numbers", { seed: random.next_seed, count: 2 }));
        const whole = structured(await call("random_numbers", { seed: 42, count: 5 }));
        assert.deepEqual([...(random.values as number[]), ...(next.values as number[])], whole.values);
        observation.random = random;
      }
      if (excludedTools.length > 0) {
        const rejected: { name: string; response: string; code?: number }[] = [];
        for (const name of excludedTools) {
          const args = name === "sleep" ? { ms: 0 } : name === "random_numbers" ? { seed: 42, count: 1 } : {};
          try {
            // Bypass the client's tool inventory/schema cache so the rejection
            // proves that this protocol request reached the filtered server.
            const result = await client.request({ method: "tools/call", params: { name, arguments: args } }, {
              timeout: 10_000, maxTotalTimeout: 10_000, signal: suiteAbort.signal,
            }) as CallToolResult;
            assert.equal(result.isError, true, `Unselected tool ${name} remained callable`);
            rejected.push({ name, response: "tool_error" });
          } catch (error) {
            assert.ok(error && typeof error === "object" && "code" in error, `Expected an MCP rejection for ${name}`);
            assert.ok(error.code === -32601 || error.code === -32602, `Unexpected rejection code for ${name}: ${String(error.code)}`);
            rejected.push({ name, response: "rpc_error", code: error.code });
          }
        }
        observation.rejected_tools = rejected;
      }
      observations.push(observation);
    } finally { await client.close(); }
  }
  if (rootFlag) {
    const root = new URL("/", endpoint);
    const fragment = toolset === "tinytools" ? "tiny-tools" : toolset;
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(root, { method, redirect: "manual", signal: suiteAbort.signal });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `https://github.com/mttmcknn/tiny-tools#${fragment}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.body?.cancel();
    }
  }
  console.log(JSON.stringify({ passed: true, endpoint: endpoint.href, observed_at_utc: new Date().toISOString(), toolset, attempts, root_checked: Boolean(rootFlag), observations, traces }, null, 2));
} finally { clearTimeout(timer); }
