/**
 * Admin/infrastructure tools for the pqdb MCP server.
 *
 * Tools:
 *   - pqdb_execute_sql: execute raw SQL queries (service key only)
 *   - pqdb_list_extensions: list installed Postgres extensions
 *   - pqdb_list_migrations: list Alembic migration history (dev JWT)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Standard { data, error } response shape. */
interface ApiResponse {
  data: unknown | null;
  error: string | null;
}

import { authFetch as apikeyGet, authPost as apikeyPost } from "./auth-state.js";

/** Build a success MCP tool result. */
function successResult(data: ApiResponse): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

/** Build an error MCP tool result. */
function errorResult(data: ApiResponse): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

/** Check that dev token is available, return error result if not. */
function requireDevToken(devToken: string | undefined): ReturnType<typeof errorResult> | null {
  if (!devToken) {
    return errorResult({
      data: null,
      error:
        "Developer authentication required. Set the PQDB_DEV_TOKEN environment variable " +
        "with a valid developer JWT to use this tool.",
    });
  }
  return null;
}

/**
 * Register admin/infrastructure tools on the MCP server.
 */
export function registerAdminTools(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
  devToken: string | undefined,
  projectId?: string,
): void {
  // ── pqdb_execute_sql ────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_execute_sql",
    "Execute a raw SQL query against the project database. Requires a service_role API key.",
    {
      query: z.string().describe("SQL query to execute"),
      mode: z
        .enum(["read", "write"])
        .optional()
        .describe("Query mode: 'read' (default) for SELECT, 'write' for INSERT/UPDATE/DELETE/DDL"),
    },
    async ({ query, mode }) => {
      try {
        const result = await apikeyPost<unknown>(
          projectUrl,
          apiKey,
          "/v1/db/sql",
          { query, mode: mode ?? "read" },
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "SQL execution failed",
        });
      }
    },
  );

  // ── pqdb_list_extensions ────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_extensions",
    "List installed Postgres extensions in the project database",
    {},
    async () => {
      try {
        const extensions = await apikeyGet<unknown[]>(
          projectUrl,
          apiKey,
          "/v1/db/extensions",
        );

        return successResult({ data: extensions, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list extensions",
        });
      }
    },
  );

  // ── pqdb_list_migrations ────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_migrations",
    "List Alembic migration history for the project. Requires PQDB_DEV_TOKEN.",
    {},
    async () => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const migrations = await apikeyGet<unknown[]>(
          projectUrl,
          "",
          "/v1/projects/migrations",
        );

        return successResult({ data: migrations, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list migrations",
        });
      }
    },
  );
}
