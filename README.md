# Tiny Tools MCP

Small public MCP tools hosted on Cloudflare Workers. This repository contains the shared source, tests, and deployment configurations for Sleep, Random, and the combined Tiny Tools server. No client account or token is needed.

The endpoints below are live. The existing public Sleep endpoint remains [sleep-mcp.mmckenna.workers.dev/mcp](https://sleep-mcp.mmckenna.workers.dev/mcp).

| Tool | Description | MCP URL |
| --- | --- | --- |
| [Sleep](tools/sleep/README.md) | Observe UTC/epoch time with `current_time` and wait up to one hour with `sleep`. | [sleep.mttmcknn.dev/mcp](https://sleep.mttmcknn.dev/mcp) |
| [Random](tools/random/README.md) | Generate reproducible seeded values in `[0,1)` with `random_numbers`. | [random.mttmcknn.dev/mcp](https://random.mttmcknn.dev/mcp) |
| [Tiny Tools](#tiny-tools) | Use all three tools through one combined connection. | [tools.mttmcknn.dev/mcp](https://tools.mttmcknn.dev/mcp) |

## Connect

Add one of the URLs above as a remote HTTP MCP server in your MCP client. Choose Tiny Tools to get all three tools through one connection, or the individual server for a smaller tool inventory. Select no authentication if your client asks. Each endpoint uses Streamable HTTP and supports both legacy and modern MCP clients.

The URLs ending in `/mcp` are protocol endpoints. Visiting a hostname without `/mcp` opens the corresponding section of this README.

## Sleep

Call `current_time` with `{}` or `sleep` with `{"ms":2000}`. Responses contain UTC/epoch timestamps and measured elapsed time. Use these tools to ground time calculations, pace retries, or pause before checking an explicitly timed animation. Sleep is capped at one hour; client timeouts and disconnects can interrupt it.

See the [Sleep README](tools/sleep/README.md) for inputs, outputs, and timing behavior. The original [workers.dev MCP endpoint](https://sleep-mcp.mmckenna.workers.dev/mcp) remains supported.

## Random

Call `random_numbers` with `{"seed":42,"count":3}`. It returns reproducible values in `[0,1)` and a `next_seed` for continuation. Seeds are integers from 0 through 4,294,967,295; count defaults to 1 and is capped at 100. Pass the returned `next_seed` as the next call's seed to continue the sequence. The Mulberry32 generator is deterministic and noncryptographic.

See the [Random README](tools/random/README.md) for inputs, outputs, and sequence continuation.

## Tiny Tools

Connect once to the combined server to use `current_time`, `sleep`, and `random_numbers` together. It registers the same modules as the individual servers; tools and their input/output schemas are identical.

## Source layout

Each tool directory contains its implementation and README:

```text
tools/
  sleep/       # current_time and sleep
    index.ts
    README.md
  random/      # random_numbers
    index.ts
    README.md
src/
  clock.ts     # shared clock and abortable timer
  config.ts    # shared bounds and configuration
  index.ts     # shared HTTP MCP routing and validation
  server.ts    # selects Sleep, Random, or both
tests/         # clock, protocol, routing, Random, and combined-server checks
scripts/       # clients and bounded smoke checks
```

## Local setup and verification

Use Node 24.12+ and `npm ci`. `npm run dev` serves Sleep on port 8787; `npm run dev:random` serves Random on 8788; `npm run dev:tinytools` serves Tiny Tools on 8789. Each MCP path is `/mcp`. GET/HEAD `/` redirects to this repository's corresponding section.

```sh
git clone https://github.com/mttmcknn/tiny-tools.git
cd tiny-tools
npm ci
npm run dev:tinytools
```

Run `npm test`, `npm run typecheck`, and each dry build: `npm run build`, `npm run build:random`, `npm run build:tinytools`. Run bounded protocol smoke checks against a running server with `npm run smoke:endpoint -- http://127.0.0.1:8789/mcp tinytools --check-root` (substitute the endpoint and toolset). This exercises legacy and modern MCP clients, tool inventories, calls, timing, and seeded continuation.

To check a deployed server:

```sh
npm run smoke:endpoint -- https://tools.mttmcknn.dev/mcp tinytools --check-root
```

## Deployment

The three configs deploy the `sleep-mcp`, `random-mcp`, and `tiny-tools-mcp` Workers and attach their respective Cloudflare Worker Custom Domains. Cloudflare manages DNS and TLS. `workers_dev` stays enabled, including for the original Sleep endpoint.

Sleep uses [`wrangler.jsonc`](wrangler.jsonc), Random uses [`wrangler.random.jsonc`](wrangler.random.jsonc), and the combined server uses [`wrangler.tinytools.jsonc`](wrangler.tinytools.jsonc). All three use the shared entrypoint in [`src/index.ts`](src/index.ts).

Maintainers can use an authorized Cloudflare connection or Wrangler session, then run `npm run deploy`, `npm run deploy:random`, and `npm run deploy:tinytools` for the corresponding Worker. These commands publish code and attach the configured domains.

For your own deployment, replace `account_id`, each custom-domain route, and `ALLOWED_HOSTNAMES` in the configurations with your account and hosts. `ALLOWED_HOSTNAMES` must include every hostname you intend clients to use. Update `REPOSITORY_URL` if you want the root redirect to point to your own repository. The npm scripts store local Wrangler state and logs in ignored project directories.

The original [sleep-mcp repository](https://github.com/mttmcknn/sleep-mcp) remains available. Active shared development for all three services is here in [mttmcknn/tiny-tools](https://github.com/mttmcknn/tiny-tools).
