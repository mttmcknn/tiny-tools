import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type ClientOptions, type FetchLike } from "@modelcontextprotocol/client";
import { createWorker } from "../src/index.ts";
import { DEFAULT_MAX_SLEEP_MS, HARD_MAX_SLEEP_MS, MAX_REQUEST_BODY_BYTES, type Env } from "../src/config.ts";
import { CLOCK_SOURCE, type ClockRuntime } from "../src/clock.ts";

const BASE = Date.parse("2026-10-01T12:34:56.789Z");
const URL_MCP = new URL("http://localhost/mcp");
const ENV = { MAX_SLEEP_MS: "100" };

function fakeClock() {
  let now = BASE;
  const calls: number[] = [];
  const runtime: ClockRuntime = {
    now: () => now,
    async wait(ms, signal) {
      signal.throwIfAborted();
      calls.push(ms);
      now += ms;
    },
  };
  return { runtime, calls };
}

function clientHarness(runtime: ClockRuntime, options: ClientOptions = {}, env: Env = ENV) {
  const worker = createWorker(runtime);
  const requests: { method: string; rpc?: string; status: number; cacheControl: string | null; sessionId: string | null }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("host", new URL(request.url).host);
    const rpc = request.method === "POST" ? (await request.clone().json() as { method?: string }).method : undefined;
    const response = await worker.fetch(request, env);
    requests.push({ method: request.method, rpc, status: response.status, cacheControl: response.headers.get("cache-control"), sessionId: response.headers.get("mcp-session-id") });
    return response;
  };
  const client = new Client({ name: "sleep-mcp-test", version: "1.0.0" }, options);
  const transport = new StreamableHTTPClientTransport(URL_MCP, { fetch });
  return { client, transport, requests };
}

test("legacy SDK client initializes, lists, and calls both tools over stateless HTTP", async () => {
  const { runtime, calls } = fakeClock();
  const { client, transport, requests } = clientHarness(runtime);
  try {
    await client.connect(transport, { timeout: 1_000 });
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal(client.getServerVersion()?.name, "sleep-mcp");
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["current_time", "sleep"]);
    for (const tool of tools) {
      assert.ok(tool.outputSchema);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const current = await client.callTool({ name: "current_time", arguments: {} });
    assert.deepEqual(current.structuredContent, {
      utc: "2026-10-01T12:34:56.789Z", epoch_ms: BASE, epoch_seconds: BASE / 1_000,
      clock_source: CLOCK_SOURCE, max_sleep_ms: 100,
    });
    const slept = await client.callTool({ name: "sleep", arguments: { ms: 50 } });
    assert.equal(slept.isError, undefined);
    const sleepData = slept.structuredContent as Record<string, unknown>;
    assert.equal(sleepData.requested_duration_ms, 50);
    assert.equal(sleepData.actual_elapsed_ms, 50);
    assert.equal(sleepData.status, "completed");
    assert.deepEqual(calls, [50]);
    assert.ok(requests.some((request) => request.rpc === "initialize"));
    assert.ok(requests.some((request) => request.rpc === "notifications/initialized"));
    assert.ok(requests.every((request) => request.sessionId === null));
    assert.ok(requests.every((request) => request.cacheControl === "no-store"));
    assert.ok(!requests.some((request) => request.rpc === "subscriptions/listen"));
  } finally {
    await client.close();
  }
});

test("modern SDK client discovers the server and calls tools without a legacy handshake", async () => {
  const { runtime } = fakeClock();
  const { client, transport, requests } = clientHarness(runtime, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(transport, { timeout: 1_000 });
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.ok(client.getDiscoverResult());
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["current_time", "sleep"]);
    const value = await client.callTool({ name: "sleep", arguments: { ms: 0 } });
    const sleepData = value.structuredContent as Record<string, unknown>;
    assert.equal(sleepData.status, "completed");
    assert.equal(sleepData.actual_elapsed_ms, 0);
    assert.equal(requests[0]?.rpc, "server/discover");
    assert.ok(!requests.some((request) => request.rpc === "initialize" || request.rpc === "subscriptions/listen"));
    assert.ok(requests.every((request) => request.sessionId === null && request.cacheControl === "no-store"));
    await assert.rejects(client.listen({}, { timeout: 1_000 }), /Subscription limit reached/);
  } finally {
    await client.close();
  }
});

test("invalid tool inputs never start a timer", async () => {
  const { runtime, calls } = fakeClock();
  const { client, transport } = clientHarness(runtime);
  try {
    await client.connect(transport, { timeout: 1_000 });
    await client.listTools();
    for (const args of [{}, { ms: -1 }, { ms: 1.5 }, { ms: 101 }, { ms: "1" }, { ms: NaN }, { ms: Infinity }, { ms: 1, extra: true }]) {
      const result = await client.callTool({ name: "sleep", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    const current = await client.callTool({ name: "current_time", arguments: { extra: true } });
    assert.equal(current.isError, true);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("the default public bound accepts exactly one hour and rejects longer requests", async () => {
  const { runtime, calls } = fakeClock();
  const { client, transport } = clientHarness(runtime, {}, {});
  try {
    await client.connect(transport, { timeout: 1_000 });
    await client.listTools();
    const current = await client.callTool({ name: "current_time", arguments: {} });
    assert.equal((current.structuredContent as Record<string, unknown>).max_sleep_ms, DEFAULT_MAX_SLEEP_MS);
    assert.equal(DEFAULT_MAX_SLEEP_MS, 3_600_000);
    assert.equal(HARD_MAX_SLEEP_MS, 3_600_000);
    const allowed = await client.callTool({ name: "sleep", arguments: { ms: DEFAULT_MAX_SLEEP_MS } });
    const sleepData = allowed.structuredContent as Record<string, unknown>;
    assert.equal(sleepData.status, "completed");
    assert.equal(sleepData.actual_elapsed_ms, DEFAULT_MAX_SLEEP_MS);
    const refused = await client.callTool({ name: "sleep", arguments: { ms: HARD_MAX_SLEEP_MS + 1 } });
    assert.equal(refused.isError, true);
    // The injected timer advances directly; this test never sleeps for an hour.
    assert.deepEqual(calls, [DEFAULT_MAX_SLEEP_MS]);
  } finally {
    await client.close();
  }
});

test("modern client cancellation aborts the server wait and leaves no pending work", async () => {
  let pending = 0;
  let observedSignal: AbortSignal | undefined;
  let signalAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { signalAborted = resolve; });
  let waitStarted!: () => void;
  const started = new Promise<void>((resolve) => { waitStarted = resolve; });
  const runtime: ClockRuntime = {
    now: () => BASE,
    wait(_ms, signal) {
      observedSignal = signal;
      pending++;
      waitStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          pending--;
          signalAborted();
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const { client, transport, requests } = clientHarness(runtime, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(transport, { timeout: 1_000 });
    const controller = new AbortController();
    const call = client.callTool({ name: "sleep", arguments: { ms: 100 } }, { signal: controller.signal, timeout: 1_000 });
    const rejected = assert.rejects(call, /abort|cancel/i);
    await started;
    assert.equal(pending, 1);
    controller.abort(new Error("test cancellation"));
    await rejected;
    await aborted;
    await nextTurn();
    assert.equal(observedSignal?.aborted, true);
    assert.equal(pending, 0);
    assert.ok(!requests.some((request) => request.rpc === "notifications/cancelled"));
  } finally {
    await client.close();
  }
});

function request(body?: string, headers: Record<string, string> = {}, method = "POST") {
  return new Request(URL_MCP, {
    method,
    headers: { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}

test("Host and Origin allowlists reject mismatches while origin-less headless clients work", async () => {
  const { runtime } = fakeClock();
  const worker = createWorker(runtime);
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const deniedHeaders: Record<string, string>[] = [{ host: "evil.example" }, { origin: "https://evil.example" }, { origin: "null" }];
  for (const headers of deniedHeaders) {
    const response = await worker.fetch(request(ping, headers), ENV);
    assert.equal(response.status, 403);
    await response.text();
  }
  const response = await worker.fetch(request(ping), ENV);
  assert.equal(response.status, 200);
  await response.text();
});

test("body bound rejects both declared and streamed oversized bodies", async () => {
  const { runtime, calls } = fakeClock();
  const worker = createWorker(runtime);
  const declared = await worker.fetch(request("{}", { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) }), ENV);
  assert.equal(declared.status, 413);
  await declared.text();
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1_024).fill(32));
      if (pulled === 32) controller.close();
    },
  });
  const streamed = new Request(URL_MCP, {
    method: "POST", headers: { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json" },
    body, duplex: "half",
  } as RequestInit);
  const response = await worker.fetch(streamed, ENV);
  assert.equal(response.status, 413);
  // SDK2.2.0 releases its bounded reader but does not cancel the request's
  // source stream. Verify it stops pulling after the limit plus stream buffers.
  await nextTurn();
  assert.ok(pulled <= MAX_REQUEST_BODY_BYTES / 1_024 + 3, `read ${pulled} chunks`);
  const stoppedAt = pulled;
  await nextTurn();
  assert.equal(pulled, stoppedAt);
  assert.deepEqual(calls, []);
  await response.text();
});

test("session GET/DELETE streams are disabled, routes are narrow, and bad config fails closed", async () => {
  const { runtime } = fakeClock();
  const worker = createWorker(runtime);
  for (const method of ["GET", "DELETE"]) {
    const response = await worker.fetch(request(undefined, {}, method), ENV);
    assert.equal(response.status, 405);
    await response.text();
  }
  const unknown = await worker.fetch(new Request("http://localhost/other", { headers: { host: "localhost" } }), ENV);
  assert.equal(unknown.status, 404);
  const badConfig = await worker.fetch(request("{}"), { MAX_SLEEP_MS: "Infinity" });
  assert.equal(badConfig.status, 500);
});
