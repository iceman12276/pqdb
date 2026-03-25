/**
 * Natural language query translation for the pqdb MCP server.
 *
 * Rule-based pattern matching that translates natural language queries
 * into pqdb API calls, respecting column sensitivity constraints.
 *
 * Tool:
 *   - pqdb_natural_language_query: accepts NL, translates, executes, returns results
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Column info from introspection. */
export interface ColumnInfo {
  name: string;
  type: string;
  sensitivity: string;
  operations?: string[];
}

/** Table info from introspection. */
export interface SchemaInfo {
  name: string;
  columns: ColumnInfo[];
}

/** Result of translating a natural language query. */
export interface TranslationResult {
  success: boolean;
  table?: string;
  columns?: string[];
  filters?: Array<{ column: string; op: string; value: string }>;
  limit?: number;
  error?: string;
}

/** Introspection API response. */
interface IntrospectAllResponse {
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: string;
      sensitivity: string;
      is_owner: boolean;
      queryable?: boolean;
      operations?: string[];
    }>;
    sensitivity_summary: Record<string, number>;
  }>;
}

/** Map NL operator symbols/words to pqdb filter ops. */
const OP_MAP: Record<string, string> = {
  "=": "eq",
  "==": "eq",
  "equals": "eq",
  "is": "eq",
  ">": "gt",
  "greater than": "gt",
  "above": "gt",
  "<": "lt",
  "less than": "lt",
  "below": "lt",
  ">=": "gte",
  "<=": "lte",
};

/**
 * Translate a natural language query into a structured pqdb query.
 *
 * Uses rule-based pattern matching. Supports patterns:
 *   - "show/get/list/select [N] <table> [where <col> <op> <val>]"
 *   - "first N <table>"
 *   - "select <cols> from <table> [where ...]"
 */
export function translateNaturalLanguage(
  query: string,
  schema: SchemaInfo[],
): TranslationResult {
  const original = query.trim();
  const normalized = original.toLowerCase();
  const tableNames = schema.map((t) => t.name);

  // Try to find a table name in the query
  let tableName: string | undefined;
  let tableSchema: SchemaInfo | undefined;

  for (const name of tableNames) {
    if (normalized.includes(name)) {
      tableName = name;
      tableSchema = schema.find((t) => t.name === name);
      break;
    }
  }

  if (!tableName || !tableSchema) {
    return {
      success: false,
      error: `Could not identify a table in the query. Available tables: ${tableNames.join(", ")}`,
    };
  }

  // Extract columns (for "select col1, col2 from table")
  let columns: string[] = ["*"];
  const selectFromMatch = normalized.match(
    /select\s+(.+?)\s+from\s+/,
  );
  if (selectFromMatch) {
    const colStr = selectFromMatch[1];
    if (colStr !== "*") {
      columns = colStr.split(/\s*,\s*/).map((c) => c.trim());
    }
  }

  // Extract limit (for "show N table" or "first N table")
  let limit: number | undefined;
  const limitMatch = normalized.match(
    /(?:show|get|list|first|top)\s+(\d+)\s+/,
  );
  if (limitMatch) {
    limit = parseInt(limitMatch[1], 10);
  }

  // Also check for "limit N" at end
  const limitEndMatch = normalized.match(/limit\s+(\d+)\s*$/);
  if (limitEndMatch) {
    limit = parseInt(limitEndMatch[1], 10);
  }

  // Extract filters (for "where col op val")
  const filters: Array<{ column: string; op: string; value: string }> = [];
  const whereMatch = normalized.match(/where\s+(.+)$/);
  // Also match on the original to preserve value casing
  const originalWhereMatch = original.toLowerCase() === normalized
    ? original.match(/where\s+(.+)$/i)
    : null;
  if (whereMatch) {
    const whereClause = whereMatch[1];
    const originalWhereClause = originalWhereMatch
      ? originalWhereMatch[1]
      : whereMatch[1];
    // Parse "col op val" patterns
    // Match: column_name >=|<=|>|<|=|== value
    const filterPattern = /(\w+)\s*(>=|<=|>|<|==|=)\s*(\S+)/g;
    // Use a separate regex on the original clause for value extraction
    const origFilterPattern = /(\w+)\s*(>=|<=|>|<|==|=)\s*(\S+)/g;
    let match;
    while ((match = filterPattern.exec(whereClause)) !== null) {
      const colName = match[1];
      const opSymbol = match[2];
      // Extract value from original casing
      const origMatch = origFilterPattern.exec(originalWhereClause);
      const value = origMatch ? origMatch[3] : match[3];

      // Validate column exists
      const colInfo = tableSchema.columns.find((c) => c.name === colName);
      if (!colInfo) {
        return {
          success: false,
          error: `Unknown column '${colName}' in table '${tableName}'. Available columns: ${tableSchema.columns.map((c) => c.name).join(", ")}`,
        };
      }

      // Translate operator
      const op = OP_MAP[opSymbol];
      if (!op) {
        return {
          success: false,
          error: `Unsupported operator '${opSymbol}'`,
        };
      }

      // Validate sensitivity constraints
      if (colInfo.sensitivity === "private") {
        return {
          success: false,
          error: `Cannot filter on column '${colName}' — it is private (encrypted, not queryable). Private columns can only be retrieved, not filtered.`,
        };
      }

      if (colInfo.sensitivity === "searchable") {
        // Searchable columns only support eq and in
        if (op !== "eq" && op !== "in") {
          return {
            success: false,
            error: `Cannot use '${opSymbol}' on column '${colName}' — it is searchable (blind-indexed). Searchable columns only support equality (=) and 'in' operations.`,
          };
        }
      }

      // Validate against allowed operations
      if (colInfo.operations && colInfo.operations.length > 0) {
        if (!colInfo.operations.includes(op)) {
          return {
            success: false,
            error: `Operation '${op}' is not supported on column '${colName}'. Supported: ${colInfo.operations.join(", ")}`,
          };
        }
      }

      filters.push({ column: colName, op, value });
    }

    // If where clause present but no filters parsed
    if (filters.length === 0) {
      return {
        success: false,
        error: `Could not parse filter conditions from: "${whereClause}". Expected format: column operator value (e.g., "age > 25")`,
      };
    }
  }

  // Check that the query had a recognizable action verb or pattern
  const hasAction = /^(show|get|list|select|find|fetch|first|top|all)\b/.test(
    normalized,
  );
  const hasTableDirectly = normalized === tableName || normalized === `all ${tableName}`;

  if (!hasAction && !hasTableDirectly && !whereMatch) {
    return {
      success: false,
      error: `Could not understand the query. Try: "show ${tableName}" or "get ${tableName} where column = value"`,
    };
  }

  return {
    success: true,
    table: tableName,
    columns,
    filters,
    limit,
  };
}

/** Module-level auth config — set by registerNlQueryTool. */
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

/**
 * Register the natural language query tool on the MCP server.
 */
export function registerNlQueryTool(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
  encryptionEnabled: boolean,
  devToken?: string,
  projectId?: string,
): void {
  _devToken = devToken;
  _projectId = projectId;
  mcpServer.tool(
    "pqdb_natural_language_query",
    "Execute a natural language query against the database. Translates to a pqdb query using schema metadata, respecting column sensitivity constraints. Examples: 'show all users', 'get posts where title = Hello', 'first 10 users'",
    {
      query: z.string().describe("Natural language query to execute"),
    },
    async ({ query }) => {
      try {
        // Step 1: Fetch schema via introspection
        const introspect = await pqdbFetch<IntrospectAllResponse>(
          projectUrl,
          apiKey,
          "/v1/db/introspect",
        );

        const schema: SchemaInfo[] = introspect.tables.map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({
            name: c.name,
            type: c.type,
            sensitivity: c.sensitivity,
            operations: c.operations,
          })),
        }));

        // Step 2: Translate NL to structured query
        const translation = translateNaturalLanguage(query, schema);

        if (!translation.success) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  data: null,
                  error: translation.error,
                  translated_query: null,
                }),
              },
            ],
          };
        }

        // Step 3: Execute the translated query
        const body: Record<string, unknown> = {
          columns: translation.columns ?? ["*"],
          filters: (translation.filters ?? []).map((f) => ({
            column: f.column,
            op: f.op,
            value: f.value,
          })),
          modifiers: {
            limit: translation.limit ?? null,
            offset: null,
            order_by: null,
            order_dir: null,
          },
        };

        const result = await pqdbPost<{ data: Record<string, unknown>[] }>(
          projectUrl,
          apiKey,
          `/v1/db/${encodeURIComponent(translation.table!)}/select`,
          body,
        );

        // Mask encrypted values if no encryption key
        const data = encryptionEnabled
          ? result.data
          : result.data.map((row) => {
              const masked: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(row)) {
                masked[key] = key.endsWith("_encrypted")
                  ? "[encrypted]"
                  : value;
              }
              return masked;
            });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                data,
                error: null,
                translated_query: {
                  table: translation.table,
                  columns: translation.columns,
                  filters: translation.filters,
                  limit: translation.limit,
                },
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                data: null,
                error: err instanceof Error ? err.message : "Query failed",
                translated_query: null,
              }),
            },
          ],
        };
      }
    },
  );
}
