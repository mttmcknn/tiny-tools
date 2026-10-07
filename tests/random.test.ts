import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type ClientOptions, type FetchLike } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MAX_RANDOM_COUNT, RANDOM_ALGORITHM, randomNumbers, randomNumbersInputSchema, randomNumbersOutputSchema, registerRandomTools } from "../tools/random/index.ts";

// Fixed vectors computed independently by compiling Tommy Ettinger's original
// unsigned-32-bit C reference with clang; the integers below precede division
// by 2^32. Source: https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
const VECTORS = [
  { seed: 0, bits: [1144304738, 1416247, 958946056, 627933444, 2007157716], next: 567894473 },
  { seed: 1, bits: [2693262067, 11749833, 2265367787, 4213581821, 4159151403], next: 567894474 },
  { seed: 42, bits: [2581720956, 1925393290, 3661312704, 2876485805, 750819978], next: 567894515 },
  { seed: 4294967295, bits: [3850105811, 813802916, 3073704848, 4054706436, 3630262831], next: 567894472 },
  { seed: 2147483648, bits: [3524353788, 1924613307, 3365584844, 2199219949, 3602660773], next: 2715378121 },
] as const;

test("Mulberry32 matches independent C vectors across unsigned seed boundaries", () => {
  for (const { seed, bits, next } of VECTORS) {
    assert.deepEqual(randomNumbers(seed, bits.length), {
      algorithm: RANDOM_ALGORITHM,
      values: bits.map((value) => value / 4294967296),
      next_seed: next,
    });
  }
});

test("next_seed resumes exactly at the next value across state wraparound", () => {
  for (const seed of [0, 42, 2147483648, 4294967295]) {
    const first = randomNumbers(seed, 70);
    const continued = randomNumbers(first.next_seed, 30);
    const whole = randomNumbers(seed, MAX_RANDOM_COUNT);
    assert.deepEqual([...first.values, ...continued.values], whole.values);
    assert.equal(continued.next_seed, whole.next_seed);
    assert.ok(whole.values.every((value) => value >= 0 && value < 1));
    assert.ok(randomNumbersOutputSchema.safeParse(whole).success);
  }
});

test("default count is one and calls share no mutable state", () => {
  const first = randomNumbers(42);
  randomNumbers(1, 100);
  assert.deepEqual(randomNumbers(42), first);
  assert.deepEqual(first, randomNumbers(42, 1));
  assert.equal(first.values.length, 1);
  assert.deepEqual(randomNumbersInputSchema.parse({ seed: 42 }), { seed: 42, count: 1 });
});

test("input rejects missing, noninteger, nonfinite, and out-of-range state or count", () => {
  for (const seed of [-1, 0.5, 4294967296, NaN, Infinity, -Infinity]) {
    assert.throws(() => randomNumbers(seed));
  }
  for (const count of [0, -1, 1.5, 101, NaN, Infinity, -Infinity]) {
    assert.throws(() => randomNumbers(0, count));
  }
  for (const input of [{}, { seed: null }, { seed: "42" }, { seed: 42, count: "1" }, { seed: 42, extra: true }]) {
    assert.equal(randomNumbersInputSchema.safeParse(input).success, false);
  }
});

test("output schema rejects invalid continuation state and values outside [0, 1)", () => {
  const valid = randomNumbers(42);
  for (const output of [
    { ...valid, next_seed: -1 }, { ...valid, next_seed: 4294967296 },
    { ...valid, values: [-0.1] }, { ...valid, values: [1] },
    { ...valid, values: [] }, { ...valid, algorithm: "unknown" },
  ]) {
    assert.equal(randomNumbersOutputSchema.safeParse(output).success, false);
  }
});

for (const [era, options] of [
  ["legacy", {}],
  ["modern", { versionNegotiation: { mode: { pin: "2026-07-28" } } }],
] as const satisfies readonly (readonly [string, ClientOptions])[]) {
  test(`${era} MCP client lists the bounded tool and receives consistent content`, async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "random-module-test", version: "1.0.0" }, {
        capabilities: { tools: { listChanged: false } },
      });
      registerRandomTools(server);
      return server;
    }, { legacy: "stateless", responseMode: "sse", maxSubscriptions: 0, keepAliveMs: 0 });
    const fetch: FetchLike = async (input, init) => handler.fetch(new Request(input, init));
    const client = new Client({ name: "random-tool-test", version: "1.0.0" }, options);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch }), { timeout: 1000 });
      assert.equal(client.getProtocolEra(), era);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["random_numbers"]);
      assert.ok(tools[0]?.outputSchema);
      assert.match(tools[0]?.description ?? "", /noncryptographic/);
      assert.deepEqual(tools[0]?.annotations, {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      });
      const result = await client.callTool({ name: "random_numbers", arguments: { seed: 42 } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, randomNumbers(42));
      assert.equal(result.content[0]?.type, "text");
      if (result.content[0]?.type === "text") {
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      }
      const continued = await client.callTool({
        name: "random_numbers", arguments: { seed: randomNumbers(42).next_seed, count: 4 },
      });
      assert.deepEqual(continued.structuredContent, randomNumbers(randomNumbers(42).next_seed, 4));
      const maximum = await client.callTool({ name: "random_numbers", arguments: { seed: 4294967295, count: 100 } });
      assert.deepEqual(maximum.structuredContent, randomNumbers(4294967295, 100));
      for (const args of [{}, { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 }, { seed: "1" }, { seed: 0, count: 0 }, { seed: 0, count: 101 }, { seed: 0, count: 1.5 }, { seed: 0, extra: true }]) {
        const rejected = await client.callTool({ name: "random_numbers", arguments: args });
        assert.equal(rejected.isError, true, JSON.stringify(args));
      }
    } finally {
      await client.close();
      await handler.close();
    }
  });
}
