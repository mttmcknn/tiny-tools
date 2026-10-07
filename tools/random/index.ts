import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const RANDOM_ALGORITHM = "mulberry32";
export const MAX_RANDOM_COUNT = 100;
const UINT32_MAX = 0xffff_ffff;
const UINT32_SIZE = 0x1_0000_0000;
const STATE_INCREMENT = 0x6d2b_79f5;

const seedSchema = z.number().int().min(0).max(UINT32_MAX);
export const randomNumbersInputSchema = z.object({
  seed: seedSchema.describe("Unsigned 32-bit integer seed, or next_seed from an earlier result"),
  count: z.number().int().min(1).max(MAX_RANDOM_COUNT).default(1)
    .describe("Number of values to return, from 1 through 100; defaults to 1"),
}).strict();
export const randomNumbersOutputSchema = z.object({
  algorithm: z.literal(RANDOM_ALGORITHM),
  values: z.array(z.number().min(0).lt(1)).min(1).max(MAX_RANDOM_COUNT),
  next_seed: seedSchema.describe("Post-generation state; use this as seed to continue the sequence"),
}).strict();
export type RandomNumbersResult = z.infer<typeof randomNumbersOutputSchema>;

/**
 * Deterministic, noncryptographic Mulberry32 with explicit unsigned 32-bit state.
 * Adapted from Tommy Ettinger's public-domain 2017 C reference:
 * https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 * Mulberry32 is not equidistributed; no statistical-quality guarantee is made.
 */
export function randomNumbers(seed: number, count = 1): RandomNumbersResult {
  const input = randomNumbersInputSchema.parse({ seed, count });
  let state = input.seed;
  const values: number[] = [];
  for (let index = 0; index < input.count; index++) {
    state = (state + STATE_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    values.push(((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_SIZE);
  }
  return { algorithm: RANDOM_ALGORITHM, values, next_seed: state };
}

export function registerRandomTools(server: McpServer) {
  server.registerTool("random_numbers", {
    description: "Return 1 through 100 deterministic Mulberry32 pseudorandom values in [0, 1). An unsigned 32-bit seed is required; count defaults to 1. The same seed and count reproduce the same result. Pass next_seed back as seed to continue. This generator is noncryptographic and not equidistributed; use it for reproducible examples, not secrets, security, or statistical guarantees.",
    inputSchema: randomNumbersInputSchema,
    outputSchema: randomNumbersOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ seed, count }) => {
    const data = randomNumbers(seed, count);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  });
}
