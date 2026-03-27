/**
 * CRUD tools for the pqdb MCP server.
 *
 * Tools:
 *   - pqdb_query_rows: SELECT rows from a table with optional filters, ordering, pagination
 *   - pqdb_insert_rows: INSERT rows into a table
 *   - pqdb_update_rows: UPDATE rows in a table matching filters
 *   - pqdb_delete_rows: DELETE rows from a table matching filters
 *
 * Encryption behavior:
 *   - When encryption key is set: values are ML-KEM encrypted before writes,
 *     decrypted after reads. Blind indexes are computed for searchable columns.
 *   - When not set: encrypted columns show "[encrypted]" and inserts/updates
 *     targeting encrypted columns are rejected.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deriveKeyPair,
  transformInsertRows,
  transformSelectResponse,
  defineTableSchema,
  ColumnDef,
} from "@pqdb/client";
import type { KeyPair, SchemaColumns, TableSchema } from "@pqdb/client";

/** Filter schema matching the backend's FilterSchema. */
const FilterZod = z.object({
  column: z.string(),
  op: z.enum(["eq", "gt", "lt", "gte", "lte", "in"]),
  value: z.unknown(),
});

/** Standard { data, error } response shape. */
interface CrudResponse {
  data: unknown[] | null;
  error: string | null;
}

/** Introspection table shape from GET /v1/db/introspect. */
interface IntrospectColumn {
  name: string;
  type: string;
  sensitivity: "plain" | "searchable" | "private";
}

interface IntrospectTable {
  name: string;
  columns: IntrospectColumn[];
}

import { authFetch as pqdbGet, authPost as pqdbPost } from "./auth-state.js";

/**
 * Replace values in _encrypted columns with "[encrypted]" when
 * no encryption key is available.
 */
function maskEncryptedValues(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      masked[key] = key.endsWith("_encrypted") ? "[encrypted]" : value;
    }
    return masked;
  });
}

/** Build a success MCP tool result. */
function successResult(response: CrudResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/** Build an error MCP tool result. */
function errorResult(response: CrudResponse) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/**
 * Build a dynamic TableSchema from introspection data.
 */
function buildTableSchema(tableName: string, columns: IntrospectColumn[]): TableSchema {
  const schemaCols: SchemaColumns = {};
  for (const col of columns) {
    const def = new ColumnDef(col.type as "text", col.sensitivity);
    schemaCols[col.name] = def;
  }
  return defineTableSchema(tableName, schemaCols);
}

/**
 * Crypto context for encryption-enabled CRUD operations.
 * Lazily initialized on first use.
 */
interface CryptoState {
  keyPair: KeyPair;
  hmacKey: Uint8Array;
}

/**
 * Register CRUD tools on the MCP server.
 */
export function registerCrudTools(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
  encryptionEnabled: boolean,
  encryptionKey?: string,
  _devToken?: string,
  _projectId?: string,
): void {
  // Lazy crypto state — derived on first encrypted operation
  let cryptoState: CryptoState | null = null;

  async function getCryptoState(): Promise<CryptoState> {
    if (cryptoState) return cryptoState;
    if (!encryptionKey) throw new Error("Encryption key not available");

    const keyPair = await deriveKeyPair(encryptionKey);

    // Fetch HMAC key for blind indexes
    const hmacResponse = await pqdbGet<{
      current_version: number;
      keys: Record<string, string>;
    }>(projectUrl, apiKey, "/v1/db/hmac-key");

    const currentKey = hmacResponse.keys[String(hmacResponse.current_version)];
    const hmacKey = hexToBytes(currentKey);

    cryptoState = { keyPair, hmacKey };
    return cryptoState;
  }

  // Schema cache — avoid re-fetching for every operation
  const schemaCache = new Map<string, { schema: TableSchema; timestamp: number }>();
  const SCHEMA_TTL = 60_000; // 1 minute

  async function getTableSchema(tableName: string): Promise<TableSchema> {
    const cached = schemaCache.get(tableName);
    if (cached && Date.now() - cached.timestamp < SCHEMA_TTL) {
      return cached.schema;
    }

    const introspect = await pqdbGet<{ tables: IntrospectTable[] }>(
      projectUrl, apiKey, "/v1/db/introspect",
    );

    const tableData = introspect.tables.find((t) => t.name === tableName);
    if (!tableData) {
      throw new Error(`Table "${tableName}" not found in schema`);
    }

    const schema = buildTableSchema(tableName, tableData.columns);
    schemaCache.set(tableName, { schema, timestamp: Date.now() });
    return schema;
  }

  /** Check if a table has any encrypted columns. */
  function tableHasEncryptedColumns(schema: TableSchema): boolean {
    return Object.values(schema.columns).some(
      (col) => col.sensitivity === "searchable" || col.sensitivity === "private",
    );
  }

  // ── pqdb_query_rows ───────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_query_rows",
    "Query rows from a table with optional filters, column selection, ordering, and pagination",
    {
      table: z.string().describe("Name of the table to query"),
      columns: z
        .array(z.string())
        .optional()
        .describe("Columns to return (default: all)"),
      filters: z
        .array(FilterZod)
        .optional()
        .describe("Filter conditions: { column, op, value }"),
      limit: z.number().optional().describe("Max rows to return"),
      offset: z.number().optional().describe("Rows to skip"),
      order_by: z.string().optional().describe("Column to order by"),
      order_dir: z
        .enum(["asc", "desc"])
        .optional()
        .describe("Order direction (default: asc)"),
      similar_to: z
        .object({
          column: z.string().describe("Vector column to search"),
          vector: z.array(z.number()).describe("Query vector"),
          limit: z.number().optional().describe("Max similar results"),
          distance: z.string().optional().describe("Distance metric (e.g. cosine, l2)"),
        })
        .optional()
        .describe("Vector similarity search parameters"),
      branch: z
        .string()
        .optional()
        .describe("Branch name to query against (default: main)"),
    },
    async ({ table, columns, filters, limit, offset, order_by, order_dir, similar_to, branch }) => {
      try {
        const body: Record<string, unknown> = {
          columns: columns ?? ["*"],
          filters: filters ?? [],
          modifiers: {
            limit: limit ?? null,
            offset: offset ?? null,
            order_by: order_by ?? null,
            order_dir: order_dir ?? null,
          },
        };

        if (similar_to) {
          body.similar_to = similar_to;
        }

        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbPost<{ data: Record<string, unknown>[] }>(
          projectUrl,
          apiKey,
          `/v1/db/${encodeURIComponent(table)}/select`,
          body,
          branchHeaders,
        );

        if (!encryptionEnabled) {
          return successResult({ data: maskEncryptedValues(result.data), error: null });
        }

        // Decrypt encrypted columns
        const schema = await getTableSchema(table);
        if (tableHasEncryptedColumns(schema)) {
          const { keyPair } = await getCryptoState();
          const decrypted = await transformSelectResponse(
            result.data,
            schema,
            keyPair.secretKey,
          );
          return successResult({ data: decrypted, error: null });
        }

        return successResult({ data: result.data, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Query failed",
        });
      }
    },
  );

  // ── pqdb_insert_rows ──────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_insert_rows",
    "Insert one or more rows into a table",
    {
      table: z.string().describe("Name of the table to insert into"),
      rows: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Array of row objects to insert"),
      branch: z
        .string()
        .optional()
        .describe("Branch name to insert into (default: main)"),
    },
    async ({ table, rows, branch }) => {
      try {
        let transformedRows = rows;

        if (encryptionEnabled) {
          const schema = await getTableSchema(table);
          if (tableHasEncryptedColumns(schema)) {
            const { keyPair, hmacKey } = await getCryptoState();
            transformedRows = await transformInsertRows(rows, schema, keyPair, hmacKey);
          }
        } else {
          // Check if any rows target encrypted columns without encryption key
          for (const row of rows) {
            const schema = await getTableSchema(table);
            const hasSensitive = Object.keys(row).some((k) => {
              const col = schema.columns[k];
              return col && (col.sensitivity === "searchable" || col.sensitivity === "private");
            });
            if (hasSensitive) {
              return errorResult({
                data: null,
                error:
                  "Cannot write to encrypted columns without an encryption key. " +
                  "Set PQDB_ENCRYPTION_KEY or connect via OAuth to enable client-side encryption.",
              });
            }
          }
        }

        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbPost<{ data: unknown[] }>(
          projectUrl,
          apiKey,
          `/v1/db/${encodeURIComponent(table)}/insert`,
          { rows: transformedRows },
          branchHeaders,
        );

        return successResult({ data: result.data, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Insert failed",
        });
      }
    },
  );

  // ── pqdb_update_rows ──────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_update_rows",
    "Update rows in a table matching the given filters",
    {
      table: z.string().describe("Name of the table to update"),
      values: z
        .record(z.string(), z.unknown())
        .describe("Column-value pairs to set"),
      filters: z
        .array(FilterZod)
        .optional()
        .describe("Filter conditions to match rows"),
      branch: z
        .string()
        .optional()
        .describe("Branch name to update in (default: main)"),
    },
    async ({ table, values, filters, branch }) => {
      try {
        let transformedValues = values;

        if (encryptionEnabled) {
          const schema = await getTableSchema(table);
          if (tableHasEncryptedColumns(schema)) {
            const { keyPair, hmacKey } = await getCryptoState();
            // transformInsertRows works for updates too — wrap as single-row array, unwrap
            const [transformed] = await transformInsertRows(
              [values],
              schema,
              keyPair,
              hmacKey,
            );
            transformedValues = transformed;
          }
        } else {
          const schema = await getTableSchema(table);
          const hasSensitive = Object.keys(values).some((k) => {
            const col = schema.columns[k];
            return col && (col.sensitivity === "searchable" || col.sensitivity === "private");
          });
          if (hasSensitive) {
            return errorResult({
              data: null,
              error:
                "Cannot write to encrypted columns without an encryption key. " +
                "Set PQDB_ENCRYPTION_KEY or connect via OAuth to enable client-side encryption.",
            });
          }
        }

        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbPost<{ data: unknown[] }>(
          projectUrl,
          apiKey,
          `/v1/db/${encodeURIComponent(table)}/update`,
          { values: transformedValues, filters: filters ?? [] },
          branchHeaders,
        );

        return successResult({ data: result.data, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Update failed",
        });
      }
    },
  );

  // ── pqdb_delete_rows ──────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_delete_rows",
    "Delete rows from a table matching the given filters",
    {
      table: z.string().describe("Name of the table to delete from"),
      filters: z
        .array(FilterZod)
        .describe("Filter conditions to match rows for deletion"),
      branch: z
        .string()
        .optional()
        .describe("Branch name to delete from (default: main)"),
    },
    async ({ table, filters, branch }) => {
      try {
        const branchHeaders = branch ? { "x-branch": branch } : undefined;
        const result = await pqdbPost<{ data: unknown[] }>(
          projectUrl,
          apiKey,
          `/v1/db/${encodeURIComponent(table)}/delete`,
          { filters },
          branchHeaders,
        );

        return successResult({ data: result.data, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Delete failed",
        });
      }
    },
  );
}

/** Convert hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
