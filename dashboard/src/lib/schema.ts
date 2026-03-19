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
