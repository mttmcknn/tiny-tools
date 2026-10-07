import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8788/mcp");
const traces: { method: string; rpc?: string; status: number }[] = [];
const tracedFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const rpc = request.method === "POST" ? (await request.clone().json() as { method?: string }).method : undefined;
  const response = await fetch(request);
  traces.push({ method: request.method, rpc, status: response.status });
  return response;
};
const observations: unknown[] = [];
for (const modern of [false, true]) {
  const client = new Client({ name: "random-mcp-smoke", version: "1.0.0" }, {
    versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: tracedFetch }), { timeout: 5_000 });
    assert.equal(client.getServerVersion()?.name, "random-mcp");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["random_numbers"]);
    assert.ok(tools[0]?.outputSchema);
    const call = await client.callTool({ name: "random_numbers", arguments: { seed: 42, count: 3 } });
    assert.equal(call.isError, undefined);
    const value = call.structuredContent as { algorithm: string; values: number[]; next_seed: number };
    assert.deepEqual(value, {
      algorithm: "mulberry32", values: [0.6011037519201636, 0.44829055899754167, 0.8524657934904099], next_seed: 1199730185,
    });
    const text = call.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text), value);
    const continuation = await client.callTool({ name: "random_numbers", arguments: { seed: value.next_seed, count: 2 } });
    const combined = await client.callTool({ name: "random_numbers", arguments: { seed: 42, count: 5 } });
    assert.deepEqual([...value.values, ...(continuation.structuredContent as typeof value).values], (combined.structuredContent as typeof value).values);
    observations.push({ protocol: client.getProtocolEra(), result: value });
  } finally {
    await client.close();
  }
}
assert.ok(traces.some((trace) => trace.rpc === "initialize"));
assert.ok(traces.some((trace) => trace.rpc === "notifications/initialized"));
const root = new URL("/", endpoint);
for (const method of ["GET", "HEAD"]) {
  const response = await fetch(root, { method, redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://github.com/mttmcknn/tiny-tools#random");
  assert.equal(response.headers.get("cache-control"), "no-store");
  await response.body?.cancel();
}
console.log(JSON.stringify({ passed: true, endpoint: endpoint.toString(), observations, traces }, null, 2));
