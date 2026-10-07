# Random

Generate reproducible pseudorandom values from an explicit seed, with a continuation seed for the next call.

MCP URL: [https://random.mttmcknn.dev/mcp](https://random.mttmcknn.dev/mcp)

The same tool is also available through the [combined Tiny Tools endpoint](https://tools.mttmcknn.dev/mcp).

Release version: the shared [Tiny Tools CalVer](../../README.md#versioning).

## Connect

Add the MCP URL as a remote HTTP server in your MCP client. No account or token is required; choose no authentication if asked. The server uses Streamable HTTP and supports legacy and modern MCP clients.

### Select named tools

The [filtered Random endpoint](https://random.mttmcknn.dev/mcp?tools=random_numbers) exposes `random_numbers`; omitting `tools` exposes the same single tool. The combined server can select [Random alone](https://tools.mttmcknn.dev/mcp?tools=random_numbers) or [Random plus the timer](https://tools.mttmcknn.dev/mcp?tools=sleep,random_numbers). The same query works on the local Random URL, `http://127.0.0.1:8788/mcp`.

The Random deployment accepts only `random_numbers`; selecting `current_time` or `sleep` cannot expand its inventory. Duplicate names are removed and the stable order is `current_time`, `sleep`, `random_numbers`. Unknown or unavailable names, empty selections or items, and repeated `tools` parameters return HTTP 400 with an explanatory message.

This convenience filter is not an authentication boundary. Preserve the URL query through the client and any proxy, and reconnect or refresh a cached tool list after changing the selection. Verification is limited to the repository's SDK smoke client; third-party client behavior is unverified. See the [full filter rules](../../README.md#select-named-tools).

## `random_numbers` usage

```json
{"name":"random_numbers","arguments":{"seed":42,"count":3}}
```

| Input | Accepted values |
| --- | --- |
| `seed` | Required integer from 0 through 4,294,967,295 (unsigned 32-bit) |
| `count` | Optional integer from 1 through 100; defaults to 1 |

The result contains:

| Field | Meaning |
| --- | --- |
| `algorithm` | `mulberry32` |
| `values` | The requested number of values, each greater than or equal to 0 and less than 1 |
| `next_seed` | The unsigned 32-bit state after generating those values |

Pass the returned `next_seed` as the next call's `seed` to continue the sequence. The same seed and count always return the same values and continuation seed. Splitting a sequence across calls produces the same values as generating it in one call, within the per-call count limit. Calls share no mutable generator state.

Results include JSON in `structuredContent` and matching JSON text in `content`. Invalid input, including extra fields, is rejected.

The generator uses Mulberry32, adapted from [Tommy Ettinger's public-domain C reference](https://gist.github.com/tommyettinger/46a874533244883189143505d203312c). It is deterministic, noncryptographic, and not equidistributed. Use it for reproducible examples and workflows; it does not provide security or statistical-quality guarantees.

## Source and local use

The implementation, schemas, and tool registration are in [`index.ts`](index.ts). The [Random Worker configuration](../../wrangler.random.jsonc) selects this toolset while reusing the shared HTTP and MCP code in [`src`](../../src).

From the repository root:

```sh
npm ci
npm run dev:random
```

The local MCP URL is `http://127.0.0.1:8788/mcp`. In another terminal, run the bounded smoke check:

```sh
npm run smoke:endpoint -- http://127.0.0.1:8788/mcp random --check-root
```

See the [root README](../../README.md) for shared verification and deployment commands.
