/**
 * Schema types and API functions for introspection.
 * Calls GET /v1/db/introspect and POST /v1/db/tables/{name}/columns
 * via the authenticated API client with project apikey header.
 */

import { api } from "./api-client";

export type Sensitivity = "plain" | "searchable" | "private";

export interface IntrospectionColumn {
  name: string;
  type: string;
  sensitivity: Sensitivity;
  is_owner: boolean;
  queryable: boolean;
  operations?: string[];
  note?: string;
}

export interface IntrospectionTable {
  name: string;
  columns: IntrospectionColumn[];
  sensitivity_summary: Record<Sensitivity, number>;
}

export interface IntrospectResponse {
  tables: IntrospectionTable[];
}

export interface AddColumnRequest {
  name: string;
  data_type: string;
  sensitivity: Sensitivity;
  owner: boolean;
}

export async function fetchSchema(apiKey: string): Promise<IntrospectionTable[]> {
  const result = await api.fetch("/v1/db/introspect", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch schema");
  }
  const data = result.data as IntrospectResponse;
  return data.tables;
}

export async function addColumn(
  tableName: string,
  column: AddColumnRequest,
  apiKey: string,
): Promise<void> {
  const result = await api.fetch(`/v1/db/tables/${tableName}/columns`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify(column),
  });
  if (!result.ok) {
    throw new Error("Failed to add column");
  }
}

// --- Index types ---

export type IndexType = "hnsw" | "ivfflat";
export type IndexDistance = "cosine" | "l2" | "inner_product";

export interface VectorIndex {
  index_name: string;
  column: string;
  type: IndexType;
  distance: IndexDistance;
}

export interface CreateIndexRequest {
  column: string;
  type: IndexType;
  distance: IndexDistance;
}

export async function fetchIndexes(
  tableName: string,
  apiKey: string,
): Promise<VectorIndex[]> {
  const result = await api.fetch(`/v1/db/tables/${tableName}/indexes`, {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch indexes");
  }
  return result.data as VectorIndex[];
}

export async function createIndex(
  tableName: string,
  body: CreateIndexRequest,
  apiKey: string,
): Promise<VectorIndex> {
  const result = await api.fetch(`/v1/db/tables/${tableName}/indexes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    const data = result.data as { detail?: string } | null;
    throw new Error(data?.detail ?? "Failed to create index");
  }
  return result.data as VectorIndex;
}

export async function dropIndex(
  tableName: string,
  indexName: string,
  apiKey: string,
): Promise<void> {
  const result = await api.fetch(
    `/v1/db/tables/${tableName}/indexes/${indexName}`,
    {
      method: "DELETE",
      headers: { apikey: apiKey },
    },
  );
  if (!result.ok) {
    throw new Error("Failed to drop index");
  }
}

/**
 * Physical column name mapping.
 * Sensitive columns have shadow columns in the physical schema.
 */
export function getPhysicalColumns(
  column: IntrospectionColumn,
): { name: string; type: string }[] {
  if (column.sensitivity === "searchable") {
    return [
      { name: `${column.name}_encrypted`, type: "bytea" },
      { name: `${column.name}_index`, type: "text" },
    ];
  }
  if (column.sensitivity === "private") {
    return [{ name: `${column.name}_encrypted`, type: "bytea" }];
  }
  return [{ name: column.name, type: column.type }];
}

// --- Foreign key types ---

export interface ForeignKeyInfo {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

/**
 * Fetch foreign key relationships for the current project database.
 * Uses the SQL endpoint to query information_schema.
 */
/** Validate a Postgres identifier to prevent SQL injection. */
function isValidIdentifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

export async function fetchForeignKeys(
  apiKey: string,
  schema = "public",
): Promise<ForeignKeyInfo[]> {
  if (!isValidIdentifier(schema)) {
    throw new Error(`Invalid schema name: ${schema}`);
  }

  const sql = `
    SELECT
      tc.constraint_name,
      kcu.table_name AS source_table,
      kcu.column_name AS source_column,
      ccu.table_name AS target_table,
      ccu.column_name AS target_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = '${schema}'
    ORDER BY tc.constraint_name
  `;

  const result = await api.fetch("/v1/db/sql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!result.ok) {
    // SQL endpoint might not exist yet; degrade gracefully
    return [];
  }

  const data = result.data as { rows?: ForeignKeyInfo[] };
  return data.rows ?? [];
}

/**
 * Fetch available schemas in the project database.
 * Filters out internal Postgres schemas (pg_*, information_schema).
 */
export async function fetchSchemas(apiKey: string): Promise<string[]> {
  const sql = `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT LIKE 'pg_%'
      AND schema_name != 'information_schema'
    ORDER BY schema_name
  `;

  const result = await api.fetch("/v1/db/sql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!result.ok) {
    return ["public"];
  }

  const data = result.data as { rows?: { schema_name: string }[] };
  return data.rows?.map((r) => r.schema_name) ?? ["public"];
}
