/**
 * Auth tools for the pqdb MCP server.
 *
 * Tools:
 *   - pqdb_list_users: list end-users (requires service API key)
 *   - pqdb_list_roles: list configured roles
 *   - pqdb_list_policies: list RLS policies for a table
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Standard { data, error } response shape. */
interface AuthResponse {
  data: unknown[] | null;
  error: string | null;
}

/** Make an authenticated GET request to the pqdb API. */
async function pqdbFetch<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "GET",
    headers: { apikey: apiKey },
  });

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

/** Build a success MCP tool result. */
function successResult(response: AuthResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/** Build an error MCP tool result. */
function errorResult(response: AuthResponse) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/**
 * Register auth tools on the MCP server.
 */
export function registerAuthTools(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
): void {
  // ── pqdb_list_users ─────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_users",
    "List all end-users in the project. Requires a service_role API key.",
    {},
    async () => {
      try {
        const users = await pqdbFetch<unknown[]>(
          projectUrl,
          apiKey,
          "/v1/auth/users",
        );

        return successResult({ data: users, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list users",
        });
      }
    },
  );

  // ── pqdb_list_roles ─────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_roles",
    "List all configured roles (built-in and custom) in the project",
    {},
    async () => {
      try {
        const roles = await pqdbFetch<unknown[]>(
          projectUrl,
          apiKey,
          "/v1/auth/roles",
        );

        return successResult({ data: roles, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list roles",
        });
      }
    },
  );

  // ── pqdb_list_policies ──────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_policies",
    "List all RLS policies for a specific table",
    {
      table_name: z.string().describe("Name of the table to list policies for"),
    },
    async ({ table_name }) => {
      try {
        const policies = await pqdbFetch<unknown[]>(
          projectUrl,
          apiKey,
          `/v1/db/tables/${encodeURIComponent(table_name)}/policies`,
        );

        return successResult({ data: policies, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list policies",
        });
      }
    },
  );
}
