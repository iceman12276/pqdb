#!/usr/bin/env node
/**
 * CLI entry point for the pqdb MCP server.
 *
 * Usage:
 *   PQDB_API_KEY=... pqdb-mcp --project-url http://localhost:8000 [--transport stdio|sse] [--port 3001]
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { parseArgs, buildConfig } from "./config.js";
import { createPqdbMcpServer } from "./server.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig(args);
  const { mcpServer } = createPqdbMcpServer(config);

  if (config.transport === "stdio") {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error(
      `[pqdb-mcp] Server running on stdio (project: ${config.projectUrl})`,
    );
  } else {
    // SSE transport via Express
    const app = express();

    // Store transports for session management
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
