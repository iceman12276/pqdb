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

/** Make an authenticated GET request using apikey header. */
async function apikeyGet<T>(
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

/** Make an authenticated POST request using apikey header. */
async function apikeyPost<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "POST",
    headers: {
      apikey: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = (await response.json()) as { detail?: string };
      detail = errorBody.detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

/** Make an authenticated GET request using developer JWT. */
async function devGet<T>(
  projectUrl: string,
  devToken: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${devToken}` },
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
function successResult(response: ApiResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/** Build an error MCP tool result. */
function errorResult(response: ApiResponse) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
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
        const migrations = await devGet<unknown[]>(
          projectUrl,
          devToken!,
          "/v1/db/migrations",
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
