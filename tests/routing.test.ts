import assert from "node:assert/strict";
import { VERSION } from "../src/version.ts";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type ClientOptions, type FetchLike } from "@modelcontextprotocol/client";
import { createWorker } from "../src/index.ts";
import type { ClockRuntime } from "../src/clock.ts";
import type { Env } from "../src/config.ts";

const REPOSITORY = "https://github.com/mttmcknn/tiny-tools";
type RoutingEnv = Env & { TOOLSET?: string; REPOSITORY_URL?: string };

function rootWorker() {
  // Repository navigation must not read a clock or schedule tool work.
  const runtime: ClockRuntime = {
    now() { throw new Error("Routing unexpectedly read the tool clock"); },
    async wait() { throw new Error("Routing unexpectedly scheduled a tool wait"); },
  };
  return createWorker(runtime);
}

function request(path: string, method = "GET", headers: Record<string, string> = {}) {
  return new Request(new URL(path, "http://localhost"), {
    method, headers: { host: "localhost", ...headers },
  });
}

for (const method of ["GET", "HEAD"]) {
  for (const [toolset, fragment] of [[undefined, "sleep"], ["sleep", "sleep"], ["random", "random"], ["tinytools", "tiny-tools"]] as const) {
    test(`${method} / redirects ${toolset ?? "default"} toolset to its repository section`, async () => {
      const env: RoutingEnv = toolset === undefined ? {} : { TOOLSET: toolset };
      const response = await rootWorker().fetch(request("/", method), env);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `${REPOSITORY}#${fragment}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (method === "HEAD") assert.equal(await response.text(), "");
    });
  }
}

test("a configured repository URL replaces the redirect destination for all toolsets", async () => {
  const repository = "https://example.com/tiny-tools-mcp";
  const worker = rootWorker();
  for (const toolset of ["sleep", "random", "tinytools"] as const) {
    const env: RoutingEnv = { TOOLSET: toolset, REPOSITORY_URL: repository };
    const response = await worker.fetch(request("/"), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${repository}#${toolset === "tinytools" ? "tiny-tools" : toolset}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("root navigation parameters do not change the configured redirect destination", async () => {
  const response = await rootWorker().fetch(request("/?next=https://untrusted.example/path"), {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${REPOSITORY}#sleep`);
});

test("root redirects are limited to GET and HEAD", async () => {
  const worker = rootWorker();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await worker.fetch(request("/", method), {});
    assert.equal(response.status, 404, method);
    assert.equal(response.headers.get("location"), null);
  }
});

test("paths other than the root or exact /mcp endpoint do not redirect", async () => {
  const worker = rootWorker();
  for (const path of ["/other", "/mcp/", "/mcp/other", "/favicon.ico"]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = await worker.fetch(request(path, method), {});
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.headers.get("location"), null);
    }
  }
});

test("root GET and HEAD validate Host and Origin before serving a redirect", async () => {
  const worker = rootWorker();
  const deniedHeaders: Record<string, string>[] = [
    { host: "untrusted.example" },
    { origin: "https://untrusted.example" },
    { origin: "null" },
  ];
  for (const method of ["GET", "HEAD"]) {
    for (const headers of deniedHeaders) {
      const response = await worker.fetch(request("/", method, headers), {});
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("location"), null);
    }
    const trusted = await worker.fetch(request("/", method, { origin: "http://localhost" }), {});
    assert.equal(trusted.status, 302);
    assert.equal(trusted.headers.get("location"), `${REPOSITORY}#sleep`);
  }
});

test("unknown toolsets fail closed before serving a redirect or MCP request", async () => {
  const worker = rootWorker();
  for (const toolset of ["", "other", "SLEEP", "sleep/random", "__proto__"]) {
    const env: RoutingEnv = { TOOLSET: toolset };
    for (const [path, method] of [["/", "GET"], ["/", "HEAD"], ["/mcp", "POST"]]) {
      const response = await worker.fetch(request(path!, method), env);
      assert.equal(response.status, 500, `${method} ${path}: ${JSON.stringify(toolset)}`);
      assert.equal(response.headers.get("location"), null);
    }
  }
});

test("unsafe or ambiguous repository destinations fail closed", async () => {
  const worker = rootWorker();
  for (const repository of [
    "", "not a URL", "http://github.com/mttmcknn/sleep-mcp", "javascript:alert(1)",
    "https://user:password@github.com/mttmcknn/sleep-mcp", "https://user@github.com/mttmcknn/sleep-mcp",
    "https://github.com/mttmcknn/tiny-tools?next=untrusted", "https://github.com/mttmcknn/tiny-tools#other",
  ]) {
    const env: RoutingEnv = { REPOSITORY_URL: repository };
    for (const [path, method] of [["/", "GET"], ["/", "HEAD"], ["/mcp", "POST"]]) {
      const response = await worker.fetch(request(path!, method), env);
      assert.equal(response.status, 500, `${method} ${path}: ${repository}`);
      assert.equal(response.headers.get("location"), null);
    }
  }
});

for (const [era, options] of [
  ["legacy", {}],
  ["modern", { versionNegotiation: { mode: { pin: "2026-07-28" } } }],
] as const satisfies readonly (readonly [string, ClientOptions])[]) {
test(`${era} clients observe toolset and sleep bound switches without stale cache entries`, async () => {
  const base = Date.parse("2026-10-01T12:34:56.789Z");
  let now = base;
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
  const phases = [
    ["sleep", 100], ["random", 100], ["tinytools", 100], ["random", 100], ["sleep", 100],
    ["tinytools", 10], ["tinytools", 20],
  ] as const;
  for (const [toolset, maxSleepMs] of phases) {
    // The first switches distinguish the toolset alone; the final ones change
    // the sleep cap while retaining the combined toolset.
    const env: RoutingEnv = { TOOLSET: toolset, MAX_SLEEP_MS: String(maxSleepMs) };
    const fetch: FetchLike = async (input, init) => {
      const incoming = new Request(input, init);
      incoming.headers.set("host", "localhost");
      return worker.fetch(incoming, env);
    };
    const client = new Client({ name: "toolset-switch-test", version: "1.0.0" }, options);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch }), { timeout: 1_000 });
      assert.equal(client.getProtocolEra(), era);
      assert.deepEqual(client.getServerVersion(), {
        name: toolset === "tinytools" ? "tiny-tools-mcp" : `${toolset}-mcp`,
        version: VERSION,
      });
      const listed = await client.listTools();
      const expectedTools = toolset === "sleep" ? ["current_time", "sleep"]
        : toolset === "random" ? ["random_numbers"] : ["current_time", "random_numbers", "sleep"];
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedTools);
      if (toolset !== "random") {
        const clock = await client.callTool({ name: "current_time", arguments: {} });
        assert.equal(clock.isError, undefined);
        assert.equal((clock.structuredContent as Record<string, unknown>).epoch_ms, now);
        assert.equal((clock.structuredContent as Record<string, unknown>).max_sleep_ms, maxSleepMs);
        const refused = await client.callTool({ name: "sleep", arguments: { ms: maxSleepMs + 1 } });
        assert.equal(refused.isError, true);
        const slept = await client.callTool({ name: "sleep", arguments: { ms: 5 } });
        assert.equal(slept.isError, undefined);
        const data = slept.structuredContent as Record<string, unknown>;
        assert.equal(data.status, "completed");
        assert.equal(data.actual_elapsed_ms, 5);
      }
      if (toolset !== "sleep") {
        const beforeRandom = now;
        const random = await client.callTool({ name: "random_numbers", arguments: { seed: 42 } });
        assert.equal(random.isError, undefined);
        const data = random.structuredContent as Record<string, unknown>;
        assert.equal(data.algorithm, "mulberry32");
        // Independent C-reference first output already verified in random.test.ts.
        assert.deepEqual(data.values, [2581720956 / 4294967296]);
        assert.equal(now, beforeRandom, "Random tools must not use the sleep clock");
      }
    } finally {
      await client.close();
    }
  }
  assert.deepEqual(waits, [5, 5, 5, 5, 5]);
});
}
