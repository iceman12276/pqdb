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

import { authFetch as pqdbFetch, authPost as pqdbPost } from "./auth-state.js";

/**
 * Register schema tools and resources on the MCP server.
 */
export function registerSchemaTools(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
  _devToken?: string,
  _projectId?: string,
): void {
  // ── Tools ──────────────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_create_table",
    "Create a new table with column definitions and sensitivity levels",
    {
      name: z.string().describe("Table name"),
      columns: z
        .array(
          z.object({
            name: z.string().describe("Column name"),
            data_type: z
              .string()
              .describe("Postgres data type (text, integer, boolean, etc.)"),
            sensitivity: z
              .enum(["plain", "searchable", "private"])
              .default("plain")
              .describe(
                "plain = unencrypted, searchable = encrypted + blind index, private = encrypted only",
              ),
            owner: z
              .boolean()
              .default(false)
              .describe("Whether this column identifies the row owner for RLS"),
          }),
        )
        .describe("Column definitions"),
      branch: z
        .string()
        .optional()
        .describe("Branch name to create the table in (default: main)"),
    },
    async ({ name, columns, branch }) => {
      try {
        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbPost<Record<string, unknown>>(
          projectUrl,
          apiKey,
          "/v1/db/tables",
          { name, columns },
          branchHeaders,
        );

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "Failed to create table",
            },
          ],
        };
      }
    },
  );

  mcpServer.tool(
    "pqdb_list_tables",
    "List all tables with column count and sensitivity summary",
    {
      branch: z
        .string()
        .optional()
        .describe("Branch name to list tables from (default: main)"),
    },
    async ({ branch }) => {
      try {
        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbFetch<IntrospectAllResponse>(
          projectUrl,
          apiKey,
          "/v1/db/introspect",
          branchHeaders,
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
    {
      table_name: z.string().describe("Name of the table to describe"),
      branch: z
        .string()
        .optional()
        .describe("Branch name to describe table from (default: main)"),
    },
    async ({ table_name, branch }) => {
      try {
        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbFetch<IntrospectTable>(
          projectUrl,
          apiKey,
          `/v1/db/introspect/${encodeURIComponent(table_name)}`,
          branchHeaders,
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
    {
      branch: z
        .string()
        .optional()
        .describe("Branch name to describe schema from (default: main)"),
    },
    async ({ branch }) => {
      try {
        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbFetch<IntrospectAllResponse>(
          projectUrl,
          apiKey,
          "/v1/db/introspect",
          branchHeaders,
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
