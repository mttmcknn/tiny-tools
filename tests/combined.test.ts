import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type ClientOptions, type FetchLike } from "@modelcontextprotocol/client";
import { CLOCK_SOURCE, type ClockRuntime } from "../src/clock.ts";
import type { Env } from "../src/config.ts";
import { createWorker } from "../src/index.ts";
import { randomNumbers } from "../tools/random/index.ts";

const BASE = Date.parse("2026-10-07T12:34:56.789Z");
const COMBINED_HOST = "tools.mttmcknn.dev";

for (const [era, options] of [
  ["legacy", {}],
  ["modern", { versionNegotiation: { mode: { pin: "2026-07-28" } } }],
] as const satisfies readonly (readonly [string, ClientOptions])[]) {
  test(`${era} client uses all Tiny Tools over the combined custom hostname`, async () => {
    let now = BASE;
    const waits: number[] = [];
    const runtime: ClockRuntime = {
      now: () => now,
      async wait(ms, signal) {
        signal.throwIfAborted();
        waits.push(ms);
        now += ms;
      },
    };
    const worker = createWorker(runtime);
    const env: Env = { TOOLSET: "tinytools", MAX_SLEEP_MS: "100", ALLOWED_HOSTNAMES: COMBINED_HOST };
    const requests: { rpc?: string; sessionId: string | null; cacheControl: string | null }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("host", COMBINED_HOST);
      const rpc = request.method === "POST" ? (await request.clone().json() as { method?: string }).method : undefined;
      const response = await worker.fetch(request, env);
      requests.push({ rpc, sessionId: response.headers.get("mcp-session-id"), cacheControl: response.headers.get("cache-control") });
      return response;
    };
    const client = new Client({ name: "combined-tools-test", version: "1.0.0" }, options);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`https://${COMBINED_HOST}/mcp`), { fetch }), { timeout: 1_000 });
      assert.equal(client.getProtocolEra(), era);
      assert.equal(client.getServerVersion()?.name, "tiny-tools-mcp");
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
      assert.match(client.getInstructions() ?? "", /current_time.*sleep/s);
      assert.match(client.getInstructions() ?? "", /seed.*cryptography/s);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["current_time", "random_numbers", "sleep"]);
      for (const tool of tools) {
        assert.ok(tool.outputSchema, tool.name);
        assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      }

      const current = await client.callTool({ name: "current_time", arguments: {} });
      assert.equal(current.isError, undefined);
      assert.deepEqual(current.structuredContent, {
        utc: "2026-10-07T12:34:56.789Z", epoch_ms: BASE, epoch_seconds: BASE / 1_000,
        clock_source: CLOCK_SOURCE, max_sleep_ms: 100,
      });
      const random = await client.callTool({ name: "random_numbers", arguments: { seed: 42, count: 3 } });
      assert.equal(random.isError, undefined);
      assert.deepEqual(random.structuredContent, randomNumbers(42, 3));
      assert.deepEqual(waits, []);
      assert.equal(now, BASE);
      const slept = await client.callTool({ name: "sleep", arguments: { ms: 100 } });
      assert.equal(slept.isError, undefined);
      assert.equal((slept.structuredContent as Record<string, unknown>).actual_elapsed_ms, 100);
      const afterSleep = await client.callTool({ name: "current_time", arguments: {} });
      assert.equal((afterSleep.structuredContent as Record<string, unknown>).epoch_ms, BASE + 100);
      const repeated = await client.callTool({ name: "random_numbers", arguments: { seed: 42, count: 3 } });
      assert.deepEqual(repeated.structuredContent, random.structuredContent);

      for (const input of [
        { name: "sleep", arguments: { ms: 101 } },
        { name: "current_time", arguments: { extra: true } },
        { name: "random_numbers", arguments: { seed: 42, count: 101 } },
      ]) {
        const invalid = await client.callTool(input);
        assert.equal(invalid.isError, true, input.name);
      }
      assert.deepEqual(waits, [100]);
      assert.ok(requests.every((request) => request.sessionId === null && request.cacheControl === "no-store"));
      assert.ok(!requests.some((request) => request.rpc === "subscriptions/listen"));
      assert.equal(requests[0]?.rpc, era === "modern" ? "server/discover" : "initialize");
    } finally {
      await client.close();
    }
  });
}

test("custom hostname allowlists admit only the selected service for roots and MCP", async () => {
  const runtime: ClockRuntime = {
    now() { throw new Error("Host validation unexpectedly read the clock"); },
    async wait() { throw new Error("Host validation unexpectedly scheduled a wait"); },
  };
  const worker = createWorker(runtime);
  const services = [
    ["sleep", "sleep.mttmcknn.dev", "sleep"],
    ["random", "random.mttmcknn.dev", "random"],
    ["tinytools", COMBINED_HOST, "tiny-tools"],
  ] as const;
  for (const [toolset, hostname, fragment] of services) {
    const env: Env = { TOOLSET: toolset, ALLOWED_HOSTNAMES: hostname };
    for (const path of ["/", "/mcp"]) {
      const makeRequest = (headers: Record<string, string> = {}) => new Request(`https://${hostname}${path}`, {
        method: path === "/" ? "GET" : "POST",
        headers: {
          host: hostname, accept: "application/json, text/event-stream", "content-type": "application/json", ...headers,
        },
        ...(path === "/mcp" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) } : {}),
      });
      const acceptedHeaders: Record<string, string>[] = [{}, { origin: `https://${hostname}` }];
      for (const headers of acceptedHeaders) {
        const accepted = await worker.fetch(makeRequest(headers), env);
        assert.equal(accepted.status, path === "/" ? 302 : 200);
        if (path === "/") assert.equal(accepted.headers.get("location"), `https://github.com/mttmcknn/tiny-tools#${fragment}`);
        await accepted.text();
      }
      const sibling = services.find((service) => service[1] !== hostname)![1];
      const deniedHeaders: Record<string, string>[] = [
        { host: sibling }, { origin: `https://${sibling}` }, { origin: "null" },
        { host: `${hostname}.untrusted.example` }, { origin: `https://${hostname}.untrusted.example` },
      ];
      for (const headers of deniedHeaders) {
        const denied = await worker.fetch(makeRequest(headers), env);
        assert.equal(denied.status, 403, `${path}: ${JSON.stringify(headers)}`);
        assert.equal(denied.headers.get("location"), null);
        await denied.text();
      }
    }
  }
});
