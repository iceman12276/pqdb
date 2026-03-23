#!/usr/bin/env node
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
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { parseArgs, buildConfig } from "./config.js";
import { createPqdbMcpServer } from "./server.js";
import { createMcpHttpApp } from "./http-app.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig(args);

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

main().catch((err) => {
  console.error("[pqdb-mcp] Fatal error:", err);
  process.exit(1);
});
