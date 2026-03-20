/**
 * pqdb MCP Server — creates and configures the McpServer instance.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient } from "@pqdb/client";
import type { PqdbClient } from "@pqdb/client";
import type { ServerConfig } from "./config.js";
import { registerSchemaTools } from "./schema-tools.js";
import { registerCrudTools } from "./crud-tools.js";
import { registerAuthTools } from "./auth-tools.js";
import { registerNlQueryTool } from "./nl-query.js";
import { registerProjectTools } from "./project-tools.js";
import { registerAdminTools } from "./admin-tools.js";
import { registerDocsTools } from "./docs-tools.js";

export const SERVER_NAME = "pqdb-mcp";
export const SERVER_VERSION = "0.1.0";

export interface PqdbMcpServer {
  /** The underlying MCP server instance. */
  mcpServer: McpServer;
  /** The pqdb client used for API calls. */
  pqdbClient: PqdbClient;
  /** Whether client-side encryption is enabled. */
  encryptionEnabled: boolean;
}

/**
 * Create a configured pqdb MCP server.
 *
 * Registers capabilities (tools + resources) and configures the pqdb client
 * with the provided API key and optional encryption key.
 */
export function createPqdbMcpServer(config: ServerConfig): PqdbMcpServer {
  const mcpServer = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  const encryptionEnabled = !!config.encryptionKey;

  const pqdbClient = createClient(config.projectUrl, config.apiKey, {
    encryptionKey: config.encryptionKey,
  });

  // Register a placeholder tool so clients know the server supports tools.
  // Full tool implementations (schema, CRUD) are in US-057/US-058.
  mcpServer.tool(
    "pqdb_status",
    "Check pqdb MCP server status and connection info",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            server: SERVER_NAME,
            version: SERVER_VERSION,
            projectUrl: config.projectUrl,
            encryptionEnabled,
            transport: config.transport,
          }),
        },
      ],
    }),
  );

  // Register schema introspection tools and resources (US-057)
  registerSchemaTools(mcpServer, config.projectUrl, config.apiKey);

  // Register CRUD tools (US-058)
  registerCrudTools(mcpServer, config.projectUrl, config.apiKey, encryptionEnabled);

  // Register auth tools (US-059)
  registerAuthTools(mcpServer, config.projectUrl, config.apiKey);

  // Register natural language query tool (US-059)
  registerNlQueryTool(mcpServer, config.projectUrl, config.apiKey, encryptionEnabled);

  // Register project management tools (get, list, create, logs, pause, restore)
  registerProjectTools(mcpServer, config.projectUrl, config.apiKey, config.devToken);

  // Register admin/infrastructure tools (SQL, extensions, migrations)
  registerAdminTools(mcpServer, config.projectUrl, config.apiKey, config.devToken);

  // Register documentation and type generation tools
  registerDocsTools(mcpServer, config.projectUrl, config.apiKey);

  return { mcpServer, pqdbClient, encryptionEnabled };
}
