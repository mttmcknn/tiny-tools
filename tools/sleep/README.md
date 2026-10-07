# Sleep

Observe the server's UTC/epoch time and wait asynchronously before the next step in an MCP workflow.

MCP URL: [https://sleep.mttmcknn.dev/mcp](https://sleep.mttmcknn.dev/mcp)

The original [https://sleep-mcp.mmckenna.workers.dev/mcp](https://sleep-mcp.mmckenna.workers.dev/mcp) remains supported. Both tools are also available through the [combined Tiny Tools endpoint](https://tools.mttmcknn.dev/mcp).

Release version: the shared [Tiny Tools CalVer](../../README.md#versioning).

## Connect

Add the MCP URL as a remote HTTP server in your MCP client. No account or token is required; choose no authentication if asked. The server uses Streamable HTTP and supports legacy and modern MCP clients.

### Select one tool in the repository source

The repository's `tools` query filter has **not been deployed to the hosted endpoints**. On a local Sleep server, use `http://127.0.0.1:8787/mcp?tools=current_time` for the clock alone or `http://127.0.0.1:8787/mcp?tools=sleep` for the timer alone. Omitting `tools` exposes both. Selecting `sleep` does not implicitly add `current_time`.

Only the exact MCP names `current_time` and `sleep` are available on this deployment. `random_numbers` is available on the combined server, where `/mcp?tools=sleep,random_numbers` selects just those two tools. Duplicate names are removed and the stable order is `current_time`, `sleep`, `random_numbers`. Unknown or unavailable names, empty selections or items, and repeated `tools` parameters return HTTP 400 with an explanatory message.

This convenience filter is not an authentication boundary. Preserve the URL query through the client and any proxy, and reconnect or refresh a cached tool list after changing the selection. Verification is limited to the repository's SDK smoke client; third-party client behavior is unverified. See the [full filter rules](../../README.md#select-named-tools-in-the-repository-source).

## Tools and usage

### `current_time`

Call with an empty object:

```json
{"name":"current_time","arguments":{}}
```

The response includes `utc` (an ISO 8601 UTC timestamp), `epoch_ms`, `epoch_seconds`, `clock_source`, and `max_sleep_ms`. The deployed sleep cap is **3,600,000 ms (one hour)**.

The clock source is `server_runtime_Date.now_last_IO`: Cloudflare's runtime observes `Date.now()` at its last I/O event. Network latency and clock accuracy are not guaranteed. Use this observation to ground time calculations and bounded waits.

### `sleep`

Provide a whole number of milliseconds from 0 through 3,600,000:

```json
{"name":"sleep","arguments":{"ms":2000}}
```

The timer waits asynchronously, including yielding when `ms` is zero. The response includes:

| Field | Meaning |
| --- | --- |
| `status` | `completed`, `timer_returned_early`, `clock_moved_backwards`, or `cancelled` |
| `started_at_utc`, `ended_at_utc` | UTC timestamps at the start and end |
| `start_epoch_ms`, `end_epoch_ms` | The corresponding epoch milliseconds |
| `requested_duration_ms` | The requested wait |
| `actual_elapsed_ms` | End time minus start time |
| `difference_ms` | Actual elapsed time minus the requested wait |
| `clock_source` | `server_runtime_Date.now_last_IO` |

Scheduling may overshoot or return early; inspect `status` and measured elapsed time. Results with a status other than `completed` are marked as tool errors. Set your client's timeout above the requested delay. Client cancellation or disconnection can interrupt the timer and prevent a response.

Both tools return JSON in `structuredContent` and matching JSON text in `content`.

## Source and local use

The tool registration and schemas are in [`index.ts`](index.ts). The clock and abortable timer are shared in [`src/clock.ts`](../../src/clock.ts). The [Sleep Worker configuration](../../wrangler.jsonc) selects this toolset and preserves the original workers.dev hostname.

From the repository root:

```sh
npm ci
npm run dev
```

The local MCP URL is `http://127.0.0.1:8787/mcp`. In another terminal, run the bounded smoke check:

```sh
npm run smoke:endpoint -- http://127.0.0.1:8787/mcp sleep --check-root
```

See the [root README](../../README.md) for shared verification and deployment commands.
