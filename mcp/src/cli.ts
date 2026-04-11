/**
 * CLI entry point for the pqdb MCP server.
 *
 * Usage:
 *   # stdio (default — requires PQDB_API_KEY):
 *   PQDB_API_KEY=... pqdb-mcp --project-url http://localhost:8000
 *
 *   # SSE (legacy — requires PQDB_API_KEY):
 *   PQDB_API_KEY=... pqdb-mcp --project-url http://localhost:8000 --transport sse --port 3001
 *
 *   # HTTP with OAuth (no API key needed — browser login):
 *   pqdb-mcp --project-url http://localhost:8000 --transport http --port 3002
 *
 *   # Crypto proxy (connects to a hosted MCP server):
 *   pqdb-mcp --mode proxy --target http://localhost:3002/mcp --project-url http://localhost:8000
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { parseArgs, buildConfig } from "./config.js";
import { createPqdbMcpServer } from "./server.js";
import { createMcpHttpApp } from "./http-app.js";
import {
  discoverRecoveryFile,
  loadPrivateKeyFromRecovery,
  createCryptoProxyServer,
  proxyLogin,
} from "./proxy/index.js";
import type { ProxyConfig } from "./proxy/index.js";
import type { ServerConfig } from "./config.js";

/**
 * Start the crypto proxy: authenticate via OAuth, then connect to the
 * upstream hosted MCP and expose tools over stdio.
 *
 * Exported for testability (US-016).
 */
export async function startProxy(config: ServerConfig): Promise<void> {
  const dashboardUrl = process.env.PQDB_DASHBOARD_URL;
  if (!dashboardUrl) {
    throw new Error(
      "PQDB_DASHBOARD_URL is required for proxy mode. " +
        "Set it to the dashboard URL (e.g., https://localhost:8443).",
    );
  }

  const recoveryPath = discoverRecoveryFile(config.recoveryFile);
  const privateKey = loadPrivateKeyFromRecovery(recoveryPath);

  // Authenticate via OAuth before connecting to upstream
  const authResult = await proxyLogin(dashboardUrl);
  console.error("[pqdb-proxy] Authenticated successfully");

  const proxyConfig: ProxyConfig = {
    targetUrl: config.target!,
    privateKey,
    backendUrl: config.projectUrl,
    authToken: authResult.devJwt,
  };

  const { mcpServer } = await createCryptoProxyServer(proxyConfig);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error(
    `[pqdb-proxy] Crypto proxy connected to ${config.target} (key from ${recoveryPath})`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig(args);

  if (config.mode === "proxy") {
    await startProxy(config);
    return;
  }

  if (config.transport === "stdio") {
    const { mcpServer } = createPqdbMcpServer(config);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error(
      `[pqdb-mcp] Server running on stdio (project: ${config.projectUrl})`,
    );
  } else if (config.transport === "http") {
    // HTTP transport with OAuth authentication
    const dashboardUrl = process.env.PQDB_DASHBOARD_URL ?? "https://localhost";
    const mcpServerUrl = `http://localhost:${config.port}`;

    const app = createMcpHttpApp({
      dashboardUrl,
      mcpServerUrl,
      projectUrl: config.projectUrl,
      apiKey: config.apiKey || undefined,
      encryptionKey: config.encryptionKey,
    });

    app.listen(config.port, () => {
      console.error(
        `[pqdb-mcp] HTTP+OAuth server listening on port ${config.port} (project: ${config.projectUrl})`,
      );
      console.error(
        `[pqdb-mcp] MCP endpoint: ${mcpServerUrl}/mcp`,
      );
      console.error(
        `[pqdb-mcp] Dashboard login: ${dashboardUrl}`,
      );
    });
  } else {
    // SSE transport via Express (legacy)
    const { mcpServer } = createPqdbMcpServer(config);
    const app = express();

    const transports: Record<string, SSEServerTransport> = {};

    app.get("/sse", async (_req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      await mcpServer.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports[sessionId];
      if (!transport) {
        res.status(400).json({ error: "Unknown session" });
        return;
      }
      await transport.handlePostMessage(req, res);
    });

    app.listen(config.port, () => {
      console.error(
        `[pqdb-mcp] SSE server listening on port ${config.port} (project: ${config.projectUrl})`,
      );
    });
  }
}

/* istanbul ignore next -- entry-point guard */
const isEntryPoint =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("/cli.ts"));

if (isEntryPoint) {
  main().catch((err) => {
    console.error("[pqdb-mcp] Fatal error:", err);
    process.exit(1);
  });
}
