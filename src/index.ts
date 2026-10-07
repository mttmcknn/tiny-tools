import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { workerClock, type ClockRuntime } from "./clock.ts";
import { readConfig, MAX_REQUEST_BODY_BYTES, type Env, type Toolset } from "./config.ts";
import { createServer } from "./server.ts";

export function createWorker(runtime: ClockRuntime = workerClock) {
  // Keep the SDK router per isolate; its factory still makes a fresh server per
  // exchange. One replaceable cache entry bounds memory when configuration changes.
  let cached: { maxSleepMs: number; toolset: Toolset; handler: ReturnType<typeof createMcpHandler> } | undefined;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let config;
      try {
        config = readConfig(env);
      } catch {
        return new Response("Invalid tiny-tools-mcp configuration", { status: 500 });
      }
      const rejected = hostHeaderValidationResponse(request, config.allowedHostnames)
        ?? originValidationResponse(request, config.allowedHostnames);
      if (rejected) return rejected;
      const path = new URL(request.url).pathname;
      if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
        const fragment = config.toolset === "tinytools" ? "tiny-tools" : config.toolset;
        return new Response(null, {
          status: 302,
          headers: { Location: `${config.repositoryUrl}#${fragment}`, "Cache-Control": "no-store" },
        });
      }
      if (path !== "/mcp") return new Response("Not found. MCP endpoint: /mcp", { status: 404 });

      if (!cached || cached.maxSleepMs !== config.maxSleepMs || cached.toolset !== config.toolset) {
        const { maxSleepMs, toolset } = config;
        cached = { maxSleepMs, toolset, handler: createMcpHandler(() => createServer(runtime, maxSleepMs, toolset), {
          legacy: "stateless",
          responseMode: "sse",
          maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
          maxSubscriptions: 0, // Fixed tools need no unbounded subscription streams.
          keepAliveMs: 15_000,
        }) };
      }
      const response = await cached.handler.fetch(request);
      // UTC observations and call results must never be cached by HTTP intermediaries.
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  };
}

export default createWorker() satisfies ExportedHandler<Env>;
