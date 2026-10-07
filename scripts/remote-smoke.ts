import { VERSION } from "../src/version.ts";
import assert from "node:assert/strict";
import {
  Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport,
  type CallToolResult, type FetchLike,
} from "@modelcontextprotocol/client";

// Explicitly run: node scripts/remote-smoke.ts https://YOUR-WORKER.workers.dev/mcp
// Fixed QA only: no configurable traffic loop, redirects, authentication, or retries.
const supplied = process.argv[2];
if (!supplied || process.argv.length !== 3) {
  throw new Error("Supply exactly one HTTPS /mcp endpoint: node scripts/remote-smoke.ts https://YOUR-WORKER.workers.dev/mcp");
}
const endpoint = new URL(supplied);
if (endpoint.protocol !== "https:" || endpoint.pathname !== "/mcp" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error("Endpoint must be an HTTPS URL with path /mcp and no credentials, query, or fragment");
}

const MAX_HTTP_REQUESTS = 64;
const SHORT_TIMEOUT_MS = 10_000;
const LONG_SLEEP_MS = 90_000;
const LONG_TIMEOUT_MS = 120_000;
const CONCURRENT_CLIENTS = 8;
const SHORT_CALLS_PER_CLIENT = 2;
const LOAD_SLEEP_MS = 250;
const suiteAbort = new AbortController();
const suiteTimer = setTimeout(() => suiteAbort.abort(new Error("Remote QA total duration limit (180 seconds) reached")), 180_000);
const startedAtUtc = new Date().toISOString();
const started = performance.now();
let httpRequests = 0;
const counts: Record<string, number> = {};
const observations: Record<string, unknown>[] = [];
const traces: {
  request: number; started_at_utc: string; http_method: string; rpc_method?: string;
  status?: number; response_header_elapsed_ms?: number; content_type?: string | null; error?: string;
}[] = [];

function errorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, ...(error instanceof SdkError ? { code: error.code } : {}) }
    : { name: "UnknownError", message: String(error) };
}

const boundedFetch: FetchLike = async (input, init) => {
  suiteAbort.signal.throwIfAborted();
  const request = new Request(input, init);
  if (request.url !== endpoint.href) throw new Error("Remote QA refuses a request to any other URL");
  let rpcMethod: string | undefined;
  if (request.method === "POST") rpcMethod = (await request.clone().json() as { method?: string }).method;
  // Recheck after the asynchronous body read, so concurrent clients cannot
  // all reserve the last available request before yielding.
  if (httpRequests >= MAX_HTTP_REQUESTS) throw new Error(`Remote QA hard request budget (${MAX_HTTP_REQUESTS}) reached`);
  // Increment immediately before the sole network call; failed attempts also count.
  httpRequests++;
  const method = rpcMethod ?? request.method;
  counts[method] = (counts[method] ?? 0) + 1;
  const trace = { request: httpRequests, started_at_utc: new Date().toISOString(), http_method: request.method, rpc_method: rpcMethod } as typeof traces[number];
  traces.push(trace);
  const before = performance.now();
  try {
    const response = await fetch(request, {
      redirect: "error",
      signal: AbortSignal.any([request.signal, suiteAbort.signal]),
    });
    trace.status = response.status;
    trace.response_header_elapsed_ms = Math.round(performance.now() - before);
    trace.content_type = response.headers.get("content-type");
    return response;
  } catch (error) {
    trace.error = errorDetails(error).message;
    throw error;
  }
};

function makeClient(name: string, modern = false) {
  const client = new Client({ name, version: VERSION }, {
    versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy", probe: { maxRetries: 0 } },
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: boundedFetch,
    reconnectionOptions: {
      maxRetries: 0, initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1,
    },
  });
  return { client, transport };
}

function structured(result: CallToolResult) {
  // An error tool response is evidence of failure, never a successful wait.
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

async function listTools(client: Client) {
  const result = await client.listTools({}, { timeout: SHORT_TIMEOUT_MS, maxTotalTimeout: SHORT_TIMEOUT_MS, signal: suiteAbort.signal });
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["current_time", "sleep"]);
  assert.ok(result.tools.every((tool) => tool.outputSchema));
}

async function observeTime(client: Client, label: string) {
  const before = Date.now();
  const result = await client.callTool({ name: "current_time", arguments: {} }, {
    timeout: SHORT_TIMEOUT_MS, maxTotalTimeout: SHORT_TIMEOUT_MS, signal: suiteAbort.signal,
  });
  const after = Date.now();
  observations.push({ label, client_before_epoch_ms: before, client_after_epoch_ms: after, tool_result: result });
  const data = structured(result);
  assert.equal(Date.parse(String(data.utc)), data.epoch_ms);
  assert.equal(Number(data.epoch_ms) / 1_000, data.epoch_seconds);
  assert.ok(Number.isSafeInteger(data.epoch_ms));
  // Server/client clock skew is recorded, without assuming their clocks agree.
}

async function observeSleep(client: Client, label: string, ms: number, timeout = SHORT_TIMEOUT_MS) {
  const clientStartedAtUtc = new Date().toISOString();
  const before = performance.now();
  const result = await client.callTool({ name: "sleep", arguments: { ms } }, {
    timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, signal: suiteAbort.signal,
  });
  const clientElapsedMs = performance.now() - before;
  observations.push({ label, client_started_at_utc: clientStartedAtUtc, client_ended_at_utc: new Date().toISOString(),
    client_elapsed_ms: Math.round(clientElapsedMs), client_timeout_ms: timeout, tool_result: result });
  const data = structured(result);
  assert.equal(data.status, "completed");
  assert.equal(data.requested_duration_ms, ms);
  assert.equal(Date.parse(String(data.started_at_utc)), data.start_epoch_ms);
  assert.equal(Date.parse(String(data.ended_at_utc)), data.end_epoch_ms);
  assert.equal(data.actual_elapsed_ms, Number(data.end_epoch_ms) - Number(data.start_epoch_ms));
  assert.equal(data.difference_ms, Number(data.actual_elapsed_ms) - ms);
  assert.ok(Number(data.actual_elapsed_ms) >= ms);
  assert.ok(clientElapsedMs >= ms && clientElapsedMs < timeout);
}

async function cancellationChecks(client: Client) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(new Error("QA requested cancellation")), 500);
  let before = performance.now();
  let rejected: unknown;
  let unexpectedResult: CallToolResult | undefined;
  try {
    unexpectedResult = await client.callTool({ name: "sleep", arguments: { ms: 10_000 } }, {
      timeout: 5_000, maxTotalTimeout: 5_000,
      signal: AbortSignal.any([controller.signal, suiteAbort.signal]),
    });
  } catch (error) { rejected = error; }
  finally { clearTimeout(abortTimer); }
  let elapsed = performance.now() - before;
  observations.push({ label: "modern-client-abort", observed_at_utc: new Date().toISOString(),
    requested_sleep_ms: 10_000, abort_after_ms: 500, client_elapsed_ms: Math.round(elapsed),
    ...(rejected ? { error: errorDetails(rejected) } : { tool_result: unexpectedResult }) });
  assert.ok(controller.signal.aborted, "Request failed before the requested client abort");
  assert.ok(rejected instanceof Error && /cancel|abort/i.test(rejected.message), "Expected cancellation, not another network or protocol failure");
  assert.ok(elapsed < 5_000);

  before = performance.now();
  rejected = undefined;
  unexpectedResult = undefined;
  try {
    unexpectedResult = await client.callTool({ name: "sleep", arguments: { ms: 10_000 } }, {
      timeout: 500, maxTotalTimeout: 500, resetTimeoutOnProgress: false, signal: suiteAbort.signal,
    });
  } catch (error) { rejected = error; }
  elapsed = performance.now() - before;
  observations.push({ label: "modern-client-timeout", observed_at_utc: new Date().toISOString(),
    requested_sleep_ms: 10_000, client_timeout_ms: 500, client_elapsed_ms: Math.round(elapsed),
    ...(rejected ? { error: errorDetails(rejected) } : { tool_result: unexpectedResult }) });
  assert.ok(rejected instanceof SdkError && rejected.code === SdkErrorCode.RequestTimeout, "Expected the SDK request timeout, not another failure");
  assert.ok(elapsed < 5_000);
  await observeTime(client, "modern-after-abort-and-timeout");
}

let passed = false;
let failure: ReturnType<typeof errorDetails> | undefined;
try {
  const legacy = makeClient("sleep-mcp-remote-legacy");
  try {
    await legacy.client.connect(legacy.transport, { timeout: SHORT_TIMEOUT_MS, maxTotalTimeout: SHORT_TIMEOUT_MS, signal: suiteAbort.signal });
    assert.equal(legacy.client.getProtocolEra(), "legacy");
    await listTools(legacy.client);
    await observeTime(legacy.client, "legacy-current-time");
    await observeSleep(legacy.client, "legacy-one-second-wait", 1_000);
  } finally { await legacy.client.close(); }

  const modern = makeClient("sleep-mcp-remote-modern", true);
  try {
    await modern.client.connect(modern.transport, { timeout: SHORT_TIMEOUT_MS, maxTotalTimeout: SHORT_TIMEOUT_MS, signal: suiteAbort.signal });
    assert.equal(modern.client.getProtocolEra(), "modern");
    assert.equal(modern.client.getNegotiatedProtocolVersion(), "2026-07-28");
    await listTools(modern.client);
    await observeSleep(modern.client, "modern-ninety-second-wait", LONG_SLEEP_MS, LONG_TIMEOUT_MS);
    await cancellationChecks(modern.client);
  } finally { await modern.client.close(); }

  const loadStarted = performance.now();
  const settled = await Promise.allSettled(Array.from({ length: CONCURRENT_CLIENTS }, async (_, index) => {
    const name = `sleep-mcp-remote-concurrent-${index}`;
    const { client, transport } = makeClient(name);
    try {
      await client.connect(transport, { timeout: SHORT_TIMEOUT_MS, maxTotalTimeout: SHORT_TIMEOUT_MS, signal: suiteAbort.signal });
      await listTools(client);
      for (let call = 0; call < SHORT_CALLS_PER_CLIENT; call++) {
        await observeSleep(client, `${name}-call-${call}`, LOAD_SLEEP_MS);
      }
    } finally { await client.close(); }
  }));
  observations.push({ label: "bounded-concurrency-summary", observed_at_utc: new Date().toISOString(),
    clients: CONCURRENT_CLIENTS, calls_per_client: SHORT_CALLS_PER_CLIENT, requested_sleep_ms: LOAD_SLEEP_MS,
    total_client_elapsed_ms: Math.round(performance.now() - loadStarted),
    completed_clients: settled.filter((result) => result.status === "fulfilled").length,
    failures: settled.flatMap((result, index) => result.status === "rejected" ? [{ client: index, ...errorDetails(result.reason) }] : []),
  });
  assert.ok(settled.every((result) => result.status === "fulfilled"), "One or more bounded concurrent clients failed; see observations");
  assert.ok(httpRequests <= MAX_HTTP_REQUESTS);
  passed = true;
} catch (error) {
  failure = errorDetails(error);
  process.exitCode = 1;
} finally {
  clearTimeout(suiteTimer);
  console.log(JSON.stringify({ passed, endpoint: endpoint.href, started_at_utc: startedAtUtc,
    ended_at_utc: new Date().toISOString(), total_client_elapsed_ms: Math.round(performance.now() - started),
    total_http_requests: httpRequests, maximum_http_requests: MAX_HTTP_REQUESTS,
    request_counts: counts, observations, traces, ...(failure ? { failure } : {}),
    scope: "Fixed remote protocol/timing QA with at most 64 HTTP attempts, no redirects or reconnection retries, and at most eight concurrent clients. Client abort/timeout is observed; remote timer cleanup, production CPU budget, throughput, and one-hour availability are not established by this test.",
  }, null, 2));
}
