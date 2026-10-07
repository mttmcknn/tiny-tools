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

### Select named tools

The hosted endpoints support a `tools` query filter on `/mcp`. For example, [this combined connection](https://tools.mttmcknn.dev/mcp?tools=sleep,random_numbers) exposes only `sleep` and `random_numbers`. The same filter works on local servers.

Provide actual MCP tool names as one comma-separated query value. For the combined server:

| URL path | Exposed tools |
| --- | --- |
| `/mcp` | `current_time`, `sleep`, `random_numbers` |
| `/mcp?tools=sleep,random_numbers` | `sleep`, `random_numbers` |
| `/mcp?tools=current_time` | `current_time` |
| `/mcp?tools=sleep` | `sleep` |

Without `tools`, each deployment exposes its full configured inventory. A selection can only narrow that inventory: Sleep supports `current_time` and `sleep`; Random supports `random_numbers`; Tiny Tools supports all three. `current_time` and `sleep` can be selected independently. Only selected tools are registered for listing and calls.

Duplicate names are removed, and tool lists use the stable order `current_time`, `sleep`, `random_numbers` regardless of input order. Unknown names, names unavailable in that deployment, an empty selection, empty comma-separated items, or repeated `tools` query parameters return HTTP 400 with an explanatory message. For example, `/mcp?tools=random_numbers` is invalid on the Sleep server, and `/mcp?tools=sleep&tools=current_time` is invalid on every server.

The filter is a URL convenience, not an authentication or authorization boundary: anyone can connect without it to use the deployment's full inventory. Clients and proxies must preserve the query on MCP requests. Clients may cache tool inventories; reconnect or refresh the tool list after changing the URL. Query-filter compatibility verification is limited to this repository's SDK smoke client; third-party client behavior has not been verified.

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
  server.ts    # registers the selected tools and instructions
  tool-selection.ts # validates and normalizes deployment-bounded URL selections
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

Check a filtered local connection with `npm run smoke:endpoint -- 'http://127.0.0.1:8789/mcp?tools=sleep,random_numbers' tinytools`. Quote query URLs in the shell. The smoke client preserves the query, verifies the selected inventory, and sends direct protocol calls to confirm excluded tools are rejected.

To check a deployed server:

```sh
npm run smoke:endpoint -- https://tools.mttmcknn.dev/mcp tinytools --check-root
```

## Design goals

Tiny Tools is free to use and aims to keep new tools affordable within Cloudflare's free tier at reasonable usage. Prefer stateless operations, bounded inputs and outputs, small payloads, and asynchronous waits with little CPU work. Keep shared protocol code lightweight.

Assess Cloudflare's [current request and CPU limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/), and measure a tool's resource use before making scale claims. Discuss paid APIs, storage, or other paid resources before adding them. The current tools use no persistent storage or paid external APIs.

## Versioning

Tiny Tools uses one shared CalVer release version in `YYYY.M.D` format. The current repository release is **2026.10.7**. Month and day are unpadded integers so the version remains compatible with package version syntax.

Use the UTC date when preparing a release and update `package.json` plus the two root version fields in `package-lock.json` together. `package.json` is the source of truth: the shared version module reads it for all three MCP servers and the shipped clients. Builds keep that fixed release version rather than deriving a new one from the clock.

The MCP server identity advertises this value as `serverInfo.version`. Updating the live value requires deploying the corresponding Worker bundles; the endpoint URLs stay the same. MCP protocol versions and dependency versions are independent of the release version.

## Deployment

The three configs deploy the `sleep-mcp`, `random-mcp`, and `tiny-tools-mcp` Workers and attach their respective Cloudflare Worker Custom Domains. Cloudflare manages DNS and TLS. `workers_dev` stays enabled, including for the original Sleep endpoint.

Sleep uses [`wrangler.jsonc`](wrangler.jsonc), Random uses [`wrangler.random.jsonc`](wrangler.random.jsonc), and the combined server uses [`wrangler.tinytools.jsonc`](wrangler.tinytools.jsonc). All three use the shared entrypoint in [`src/index.ts`](src/index.ts).

Maintainers can use an authorized Cloudflare connection or Wrangler session, then run `npm run deploy`, `npm run deploy:random`, and `npm run deploy:tinytools` for the corresponding Worker. These commands publish code and attach the configured domains.

For your own deployment, replace `account_id`, each custom-domain route, and `ALLOWED_HOSTNAMES` in the configurations with your account and hosts. `ALLOWED_HOSTNAMES` must include every hostname you intend clients to use. Update `REPOSITORY_URL` if you want the root redirect to point to your own repository. The npm scripts store local Wrangler state and logs in ignored project directories.

The original [sleep-mcp repository](https://github.com/mttmcknn/sleep-mcp) remains available. Active shared development for all three services is here in [mttmcknn/tiny-tools](https://github.com/mttmcknn/tiny-tools).
