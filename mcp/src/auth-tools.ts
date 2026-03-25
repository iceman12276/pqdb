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

/** Module-level auth config — set by registerAuthTools. */
let _devToken: string | undefined;
let _projectId: string | undefined;

function buildAuthHeaders(apiKey: string): Record<string, string> {
  if (apiKey) {
    return { apikey: apiKey };
  }
  if (_devToken && _projectId) {
    return {
      Authorization: `Bearer ${_devToken}`,
      "x-project-id": _projectId,
    };
  }
  return {};
}

/** Make an authenticated GET request to the pqdb API. */
async function pqdbFetch<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
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

/** Make an authenticated POST request to the pqdb API. */
async function pqdbPost<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(apiKey),
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
  devToken?: string,
  projectId?: string,
): void {
  _devToken = devToken;
  _projectId = projectId;
  // ── pqdb_list_users ─────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_users",
    "List all end-users in the project",
    {},
    async () => {
      try {
        // Query _pqdb_users directly via SQL (no dedicated list endpoint exists)
        const result = await pqdbPost<{ rows: unknown[]; columns: string[]; row_count: number }>(
          projectUrl,
          apiKey,
          "/v1/db/sql",
          { query: "SELECT id, email, role, email_verified, created_at FROM _pqdb_users ORDER BY created_at DESC LIMIT 100", mode: "read" },
        );

        return successResult({ data: result.rows, error: null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to list users";
        // Table may not exist if no users have been created yet
        if (msg.includes("does not exist") || msg.includes("relation")) {
          return successResult({ data: [], error: null });
        }
        return errorResult({ data: null, error: msg });
      }
    },
  );

  // ── pqdb_list_roles ─────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_roles",
    "List all configured roles (built-in and custom) in the project",
    {},
    async () => {
      if (!_projectId || !_devToken) {
        return errorResult({ data: null, error: "Project ID and developer token required" });
      }
      try {
        // Roles endpoint is project-scoped and requires developer JWT
        const response = await fetch(
          `${projectUrl}/v1/projects/${_projectId}/auth/roles`,
          { headers: { Authorization: `Bearer ${_devToken}` } },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { detail?: string };
          throw new Error(body.detail ?? response.statusText);
        }
        const roles = (await response.json()) as unknown[];
        return successResult({ data: roles, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list roles",
        });
      }
    },
  );

  // ── pqdb_create_policy ─────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_create_policy",
    "Create a Row Level Security (RLS) policy on a table. Policies control which rows each role can access.",
    {
      table_name: z.string().describe("Name of the table to add the policy to"),
      name: z.string().describe("Unique name for this policy (e.g. 'users_own_todos_select')"),
      operation: z.enum(["select", "insert", "update", "delete"]).describe("Which CRUD operation this policy applies to"),
      role: z.string().describe("Role this policy applies to (e.g. 'authenticated', 'anon')"),
      condition: z.enum(["owner", "all", "none"]).describe("owner = only rows where user_id matches, all = allow all rows, none = deny all rows"),
    },
    async ({ table_name, name, operation, role, condition }) => {
      try {
        const result = await pqdbPost<Record<string, unknown>>(
          projectUrl,
          apiKey,
          `/v1/db/tables/${encodeURIComponent(table_name)}/policies`,
          { name, operation, role, condition },
        );

        return successResult({ data: [result], error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to create policy",
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
