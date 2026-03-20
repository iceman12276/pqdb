/**
 * MCP server configuration and tool definitions for the Dashboard MCP page.
 */

import { api } from "./api-client";

export interface McpToolParameter {
  type: string;
  description: string;
}

export interface McpTool {
  name: string;
  description: string;
  category: "status" | "schema" | "crud" | "auth" | "query";
  parameters: Record<string, McpToolParameter>;
}

/** Static list of all MCP tools matching the pqdb MCP server spec. */
export const MCP_TOOLS: McpTool[] = [
  {
    name: "pqdb_status",
    description: "Check pqdb MCP server status and connection info",
    category: "status",
    parameters: {},
  },
  {
    name: "pqdb_list_tables",
    description:
      "List all tables with column count and sensitivity summary",
    category: "schema",
    parameters: {},
  },
  {
    name: "pqdb_describe_table",
    description:
      "Describe full schema for a table — columns, types, sensitivity levels, valid operations",
    category: "schema",
    parameters: {
      table_name: {
        type: "string",
        description: "Name of the table to describe",
      },
    },
  },
  {
    name: "pqdb_describe_schema",
    description:
      "ERD-style overview of all tables with columns, types, sensitivity, and foreign key relationships",
    category: "schema",
    parameters: {},
  },
  {
    name: "pqdb_query_rows",
    description:
      "Query rows from a table with optional filters, column selection, ordering, and pagination",
    category: "crud",
    parameters: {
      table: { type: "string", description: "Name of the table to query" },
    },
  },
  {
    name: "pqdb_insert_rows",
    description: "Insert one or more rows into a table",
    category: "crud",
    parameters: {
      table: {
        type: "string",
        description: "Name of the table to insert into",
      },
      rows: {
        type: "array",
        description: "Array of row objects to insert",
      },
    },
  },
  {
    name: "pqdb_update_rows",
    description: "Update rows in a table matching the given filters",
    category: "crud",
    parameters: {
      table: { type: "string", description: "Name of the table to update" },
    },
  },
  {
    name: "pqdb_delete_rows",
    description: "Delete rows from a table matching the given filters",
    category: "crud",
    parameters: {
      table: {
        type: "string",
        description: "Name of the table to delete from",
      },
    },
  },
  {
    name: "pqdb_list_users",
    description:
      "List all end-users in the project. Requires a service_role API key.",
    category: "auth",
    parameters: {},
  },
  {
    name: "pqdb_list_roles",
    description:
      "List all configured roles (built-in and custom) in the project",
    category: "auth",
    parameters: {},
  },
  {
    name: "pqdb_list_policies",
    description: "List all RLS policies for a specific table",
    category: "auth",
    parameters: {
      table_name: {
        type: "string",
        description: "Name of the table to list policies for",
      },
    },
  },
  {
    name: "pqdb_natural_language_query",
    description:
      'Execute a natural language query against the database. Examples: "show all users", "get posts where title = Hello"',
    category: "query",
    parameters: {
      query: {
        type: "string",
        description: "Natural language query to execute",
      },
    },
  },
];

/** Fetch MCP tools (currently returns the static list). */
export function fetchMcpTools(): McpTool[] {
  return MCP_TOOLS;
}

/** Build the MCP config JSON snippet for a project. */
export function buildMcpConfigSnippet(projectId: string): object {
  return {
    mcpServers: {
      pqdb: {
        command: "npx",
        args: [
          "pqdb-mcp",
          "--project-url",
          "http://localhost:8000",
        ],
        env: {
          PQDB_API_KEY: "<your-api-key>",
          PQDB_PROJECT_URL: "http://localhost:8000",
          PQDB_ENCRYPTION_KEY: "<your-encryption-key>",
        },
      },
    },
  };
}

/** Execute an MCP tool via the SSE endpoint. */
export async function executeMcpTool(
  _projectId: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ data: unknown; error: string | null }> {
  // In a real implementation this would call the MCP SSE endpoint.
  // For now, proxy through the pqdb API based on tool name.
  try {
    let path: string;
    let method = "GET";
    let body: unknown = undefined;

    switch (toolName) {
      case "pqdb_list_tables":
      case "pqdb_describe_schema":
        path = "/v1/db/introspect";
        break;
      case "pqdb_describe_table":
        path = `/v1/db/introspect/${encodeURIComponent(params.table_name as string)}`;
        break;
      case "pqdb_list_users":
        path = "/v1/auth/users";
        break;
      case "pqdb_list_roles":
        path = "/v1/auth/roles";
        break;
      case "pqdb_list_policies":
        path = `/v1/db/tables/${encodeURIComponent(params.table_name as string)}/policies`;
        break;
      case "pqdb_query_rows":
        path = `/v1/db/${encodeURIComponent(params.table as string)}/select`;
        method = "POST";
        body = { columns: ["*"], filters: [], modifiers: {} };
        break;
      default:
        return { data: null, error: `Tool '${toolName}' not supported for test execution` };
    }

    const result = await api.fetch(path, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });

    if (!result.ok) {
      return { data: null, error: `Request failed with status ${result.status}` };
    }
    return { data: result.data, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
