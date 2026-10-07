import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type ClientOptions, type FetchLike } from "@modelcontextprotocol/client";
import type { ClockRuntime } from "../src/clock.ts";
import type { Env, Toolset } from "../src/config.ts";
import { createWorker } from "../src/index.ts";

const BASE = Date.parse("2026-10-07T12:34:56.789Z");
const ALL_TOOLS = ["current_time", "sleep", "random_numbers"] as const;
type ToolName = typeof ALL_TOOLS[number];
type Worker = ReturnType<typeof createWorker>;
const INPUTS: Record<ToolName, Record<string, unknown>> = {
  current_time: {}, sleep: { ms: 5 }, random_numbers: { seed: 42, count: 3 },
};
const ERAS = [
  ["legacy", {}],
  ["modern", { versionNegotiation: { mode: { pin: "2026-07-28" } } }],
] as const satisfies readonly (readonly [string, ClientOptions])[];

function fakeClock() {
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
  return { runtime, waits };
}

async function connect(worker: Worker, toolset: Toolset, query: string, options: ClientOptions) {
  const endpoint = new URL(`http://localhost/mcp${query}`);
  const env: Env = { TOOLSET: toolset, MAX_SLEEP_MS: "100" };
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, endpoint.href, "Every MCP exchange must preserve the selection URL");
    request.headers.set("host", "localhost");
    if (request.method === "POST") {
      const rpc = await request.clone().json() as { method?: string; params?: { name?: string } };
      if (rpc.method === "tools/call") calls.push(rpc.params?.name ?? "");
    }
    const response = await worker.fetch(request, env);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response;
  };
  const client = new Client({ name: "tool-filter-test", version: "1.0.0" }, options);
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch }), { timeout: 1_000 });
  } catch (error) {
    await client.close();
    throw error;
  }
  return { client, calls };
}

async function listedNames(client: Client) {
  // Refresh reaches the Worker again instead of merely observing the SDK cache.
  return (await client.listTools({}, { cacheMode: "refresh", timeout: 1_000 })).tools.map(tool => tool.name);
}

async function assertExcluded(client: Client, calls: string[], name: ToolName) {
  const before = calls.length;
  // Send a protocol request directly: exclusion must be enforced by the server,
  // even when a client bypasses its advertised inventory and schema cache.
  await assert.rejects(client.request({
    method: "tools/call", params: { name, arguments: INPUTS[name] },
  }, { timeout: 1_000 }), /Tool .*not found|unknown tool|not available/i);
  assert.deepEqual(calls.slice(before), [name], "The excluded call must actually reach the server");
}

for (const [era, options] of ERAS) {
  test(`${era} URL selections restrict both tool inventory and server-side calls`, async () => {
    const { runtime, waits } = fakeClock();
    const worker = createWorker(runtime);
    const cases: readonly { toolset: Toolset; query: string; expected: readonly ToolName[] }[] = [
      { toolset: "sleep", query: "", expected: ["current_time", "sleep"] },
      { toolset: "random", query: "", expected: ["random_numbers"] },
      { toolset: "tinytools", query: "", expected: ALL_TOOLS },
      { toolset: "sleep", query: "?tools=current_time", expected: ["current_time"] },
      { toolset: "sleep", query: "?tools=sleep", expected: ["sleep"] },
      { toolset: "random", query: "?tools=random_numbers", expected: ["random_numbers"] },
      { toolset: "tinytools", query: "?tools=current_time", expected: ["current_time"] },
      { toolset: "tinytools", query: "?tools=sleep", expected: ["sleep"] },
      { toolset: "tinytools", query: "?tools=random_numbers", expected: ["random_numbers"] },
      { toolset: "tinytools", query: "?tools=sleep,random_numbers", expected: ["sleep", "random_numbers"] },
      { toolset: "tinytools", query: "?tools=random_numbers,sleep,random_numbers", expected: ["sleep", "random_numbers"] },
      {
        toolset: "tinytools", query: "?tools=%20random_numbers%20,%20sleep%20,current_time,sleep",
        expected: ALL_TOOLS,
      },
    ];
    for (const { toolset, query, expected } of cases) {
      const { client, calls } = await connect(worker, toolset, query, options);
      try {
        assert.equal(client.getProtocolEra(), era);
        assert.deepEqual(await listedNames(client), expected, `${toolset}${query}`);
        const instructions = client.getInstructions() ?? "";
        for (const name of ALL_TOOLS) {
          assert.equal(instructions.includes(name), expected.includes(name), `Instructions must match ${toolset}${query}: ${name}`);
        }
        const waitsBefore = waits.length;
        for (const name of expected) {
          const result = await client.callTool({ name, arguments: INPUTS[name] }, { timeout: 1_000 });
          assert.equal(result.isError, undefined, `${toolset}${query}: ${name}`);
          const data = result.structuredContent as Record<string, unknown>;
          if (name === "current_time") {
            assert.equal(Date.parse(String(data.utc)), data.epoch_ms);
            assert.equal(data.max_sleep_ms, 100);
          } else if (name === "sleep") {
            assert.equal(data.status, "completed");
            assert.equal(data.actual_elapsed_ms, 5);
          } else {
            assert.deepEqual(data, {
              algorithm: "mulberry32", values: [2581720956, 1925393290, 3661312704].map(value => value / 4294967296),
              next_seed: 1199730185,
            });
          }
        }
        for (const name of ALL_TOOLS) {
          if (!expected.includes(name)) await assertExcluded(client, calls, name);
        }
        assert.deepEqual(waits.slice(waitsBefore), expected.includes("sleep") ? [5] : []);
        assert.deepEqual(await listedNames(client), expected, "Excluded calls must not mutate selection");
      } finally {
        await client.close();
      }
    }
  });
}

test("invalid or deployment-unavailable selections return clear 400 responses without running a tool", async () => {
  const runtime: ClockRuntime = {
    now() { throw new Error("Invalid selection read the tool clock"); },
    async wait() { throw new Error("Invalid selection scheduled a tool wait"); },
  };
  const worker = createWorker(runtime);
  const invalid: readonly [Toolset, string][] = [
    ["tinytools", "?tools"], ["tinytools", "?tools="], ["tinytools", "?tools=%20%09"],
    ["tinytools", "?tools=,sleep"], ["tinytools", "?tools=sleep,"],
    ["tinytools", "?tools=sleep,,current_time"], ["tinytools", "?tools=sleep,%20"],
    ["tinytools", "?tools=unknown"], ["tinytools", "?tools=current_time,unknown"],
    ["tinytools", "?tools=Sleep"], ["tinytools", "?tools=__proto__"],
    ["tinytools", "?tools=sleep&tools=random_numbers"], ["tinytools", "?tools=sleep&tools=sleep"],
    ["sleep", "?tools=random_numbers"], ["sleep", "?tools=sleep,random_numbers"],
    ["random", "?tools=current_time"], ["random", "?tools=sleep"],
    ["random", "?tools=random_numbers,sleep"],
  ];
  for (const [toolset, query] of invalid) {
    const response = await worker.fetch(new Request(`http://localhost/mcp${query}`, {
      method: "POST",
      headers: { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), { TOOLSET: toolset, MAX_SLEEP_MS: "100" });
    assert.equal(response.status, 400, `${toolset}${query}`);
    assert.match(await response.text(), /tool|selection|filter/i, `${toolset}${query} must explain the rejected selection`);
  }
});

for (const [era, options] of ERAS) {
  test(`${era} overlapping filtered clients cannot leak inventories or interrupt a pending sleep`, { timeout: 5_000 }, async () => {
    let now = BASE;
    let pending = 0;
    const waits: number[] = [];
    let waitStarted!: () => void;
    const started = new Promise<void>(resolve => { waitStarted = resolve; });
    let releaseWait!: () => void;
    const released = new Promise<void>(resolve => { releaseWait = resolve; });
    const runtime: ClockRuntime = {
      now: () => now,
      async wait(ms, signal) {
        signal.throwIfAborted();
        waits.push(ms);
        pending++;
        waitStarted();
        try {
          await released;
          signal.throwIfAborted();
          now += ms;
        } finally {
          pending--;
        }
      },
    };
    const worker = createWorker(runtime);
    const sleeping = await connect(worker, "tinytools", "?tools=sleep", options);
    const clients = [sleeping.client];
    const abort = new AbortController();
    let sleepCall: ReturnType<Client["callTool"]> | undefined;
    try {
      assert.deepEqual(await listedNames(sleeping.client), ["sleep"]);
      sleepCall = sleeping.client.callTool({ name: "sleep", arguments: { ms: 50 } }, { timeout: 3_000, signal: abort.signal });
      // Prevent an unhandled rejection if a later assertion fails before awaiting the call.
      void sleepCall.catch(() => {});
      await started;
      assert.equal(pending, 1);
      const [clock, random, all] = await Promise.all([
        connect(worker, "tinytools", "?tools=current_time", options),
        connect(worker, "tinytools", "?tools=random_numbers", options),
        connect(worker, "tinytools", "", options),
      ]);
      clients.push(clock.client, random.client, all.client);
      assert.deepEqual(await Promise.all([
        listedNames(clock.client), listedNames(random.client), listedNames(all.client), listedNames(sleeping.client),
      ]), [["current_time"], ["random_numbers"], ALL_TOOLS, ["sleep"]]);

      const [timeResult, randomResult] = await Promise.all([
        clock.client.callTool({ name: "current_time", arguments: {} }, { timeout: 1_000 }),
        random.client.callTool({ name: "random_numbers", arguments: { seed: 42, count: 3 } }, { timeout: 1_000 }),
      ]);
      assert.equal(timeResult.isError, undefined);
      assert.equal((timeResult.structuredContent as Record<string, unknown>).epoch_ms, BASE);
      assert.equal(randomResult.isError, undefined);
      assert.deepEqual((randomResult.structuredContent as Record<string, unknown>).values,
        [2581720956, 1925393290, 3661312704].map(value => value / 4294967296));
      await Promise.all([
        assertExcluded(clock.client, clock.calls, "sleep"),
        assertExcluded(random.client, random.calls, "current_time"),
        assertExcluded(sleeping.client, sleeping.calls, "random_numbers"),
      ]);
      assert.equal(pending, 1, "Changing another client's selection must leave the original wait active");
      assert.deepEqual(waits, [50], "Rejected calls must not start additional waits");
      releaseWait();
      const sleepResult = await sleepCall;
      assert.equal(sleepResult.isError, undefined);
      assert.equal((sleepResult.structuredContent as Record<string, unknown>).actual_elapsed_ms, 50);
      assert.equal(pending, 0);

      const afterSleep = await clock.client.callTool({ name: "current_time", arguments: {} }, { timeout: 1_000 });
      assert.equal((afterSleep.structuredContent as Record<string, unknown>).epoch_ms, BASE + 50);
      assert.deepEqual(await Promise.all([
        listedNames(sleeping.client), listedNames(random.client), listedNames(clock.client), listedNames(all.client),
      ]), [["sleep"], ["random_numbers"], ["current_time"], ALL_TOOLS]);
    } finally {
      abort.abort(new Error("Test cleanup"));
      releaseWait();
      await sleepCall?.catch(() => {});
      await Promise.all(clients.map(client => client.close()));
    }
  });
}
