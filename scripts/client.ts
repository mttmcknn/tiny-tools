import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function connectClock(endpoint: string, modern = false) {
  const client = new Client({ name: "sleep-mcp-headless-example", version: "1.0.0" }, {
    versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)), { timeout: 10_000 });
  return client;
}

if (import.meta.main) {
  const endpoint = process.argv[2] ?? "http://127.0.0.1:8787/mcp";
  const client = await connectClock(endpoint);
  try {
    console.log(JSON.stringify(await client.callTool({ name: "current_time", arguments: {} }), null, 2));
    console.log(JSON.stringify(await client.callTool({ name: "sleep", arguments: { ms: 1_000 } }, {
      timeout: 60_000, maxTotalTimeout: 60_000,
    }), null, 2));
  } finally {
    await client.close();
  }
}
