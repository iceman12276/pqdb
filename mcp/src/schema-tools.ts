/**
 * Schema tools and resources for the pqdb MCP server.
 *
 * Tools:
 *   - pqdb_list_tables: list all tables with column counts and sensitivity
 *   - pqdb_describe_table: full schema for a single table
 *   - pqdb_describe_schema: ERD-style overview of all tables
 *
 * Resources:
 *   - pqdb://tables: list of table names
 *   - pqdb://tables/{name}: column schema for a table
 *   - pqdb://tables/{name}/stats: row count and sensitivity summary
 */
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Introspected column from the pqdb API. */
interface IntrospectColumn {
  name: string;
  type: string;
  sensitivity: string;
  is_owner: boolean;
  queryable?: boolean;
  operations?: string[];
  note?: string;
}

/** Introspected table from the pqdb API. */
interface IntrospectTable {
  name: string;
  columns: IntrospectColumn[];
  sensitivity_summary: Record<string, number>;
}

/** Response from GET /v1/db/introspect. */
interface IntrospectAllResponse {
  tables: IntrospectTable[];
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

/**
 * Register schema tools and resources on the MCP server.
 */
export function registerSchemaTools(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
): void {
  // ── Tools ──────────────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_tables",
    "List all tables with column count and sensitivity summary",
    {},
    async () => {
      try {
        const result = await pqdbFetch<IntrospectAllResponse>(
          projectUrl,
          apiKey,
          "/v1/db/introspect",
        );

        const tables = result.tables.map((t) => ({
          name: t.name,
          column_count: t.columns.length,
          sensitivity_summary: t.sensitivity_summary,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(tables) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "Failed to list tables",
            },
          ],
        };
      }
    },
  );

  mcpServer.tool(
    "pqdb_describe_table",
    "Describe full schema for a table — columns, types, sensitivity levels, valid operations",
    { table_name: z.string().describe("Name of the table to describe") },
    async ({ table_name }) => {
      try {
        const result = await pqdbFetch<IntrospectTable>(
          projectUrl,
          apiKey,
          `/v1/db/introspect/${encodeURIComponent(table_name)}`,
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "Failed to describe table",
            },
          ],
        };
      }
    },
  );

  mcpServer.tool(
    "pqdb_describe_schema",
    "ERD-style overview of all tables with columns, types, sensitivity, and foreign key relationships",
    {},
    async () => {
      try {
        const result = await pqdbFetch<IntrospectAllResponse>(
          projectUrl,
          apiKey,
          "/v1/db/introspect",
        );

        const tables = result.tables.map((t) => ({
          name: t.name,
          columns: t.columns,
          sensitivity_summary: t.sensitivity_summary,
          // pqdb does not currently track FK metadata; include empty array
          // so the ERD shape is consistent for future extension
          foreign_keys: [] as string[],
        }));

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ tables }) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "Failed to describe schema",
            },
          ],
        };
      }
    },
  );

  // ── Resources ──────────────────────────────────────────────────────

  mcpServer.resource(
    "tables-list",
    "pqdb://tables",
    { description: "List of all table names in this pqdb project" },
    async (uri) => {
      const result = await pqdbFetch<IntrospectAllResponse>(
        projectUrl,
        apiKey,
        "/v1/db/introspect",
      );
      const names = result.tables.map((t) => t.name);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(names),
          },
        ],
      };
    },
  );

  mcpServer.resource(
    "table-schema",
    new ResourceTemplate("pqdb://tables/{name}", { list: undefined }),
    { description: "Column schema for a specific table" },
    async (uri, { name }) => {
      const tableName = name as string;
      const result = await pqdbFetch<IntrospectTable>(
        projectUrl,
        apiKey,
        `/v1/db/introspect/${encodeURIComponent(tableName)}`,
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  mcpServer.resource(
    "table-stats",
    new ResourceTemplate("pqdb://tables/{name}/stats", { list: undefined }),
    { description: "Row count and sensitivity summary for a table" },
    async (uri, { name }) => {
      const tableName = name as string;

      // Get schema info (sensitivity summary)
      const schema = await pqdbFetch<IntrospectTable>(
        projectUrl,
        apiKey,
        `/v1/db/introspect/${encodeURIComponent(tableName)}`,
      );

      // Get row count via select
      let rowCount = 0;
      try {
        const selectResult = await pqdbPost<{ data: unknown[] }>(
          projectUrl,
          apiKey,
          `/v1/db/${encodeURIComponent(tableName)}/select`,
          { columns: ["id"] },
        );
        rowCount = selectResult.data.length;
      } catch {
        // If select fails (e.g. empty table or no id column), row count stays 0
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              table: tableName,
              row_count: rowCount,
              sensitivity_summary: schema.sensitivity_summary,
            }),
          },
        ],
      };
    },
  );
}
