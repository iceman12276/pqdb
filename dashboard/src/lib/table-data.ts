/**
 * Table data API functions for the Dashboard.
 * Calls the project-scoped /v1/db/* endpoints via the authenticated API client.
 */

import { api } from "./api-client";

export interface TableListItem {
  name: string;
  columns: Array<{
    name: string;
    data_type: string;
    sensitivity: string;
    is_owner: boolean;
  }>;
}

export interface SelectResponse {
  data: Record<string, unknown>[];
}

export interface TableRowCountResult {
  name: string;
  row_count: number;
}

/**
 * Fetch all tables with metadata (GET /v1/db/tables).
 */
export async function fetchTables(apiKey: string): Promise<TableListItem[]> {
  const result = await api.fetch("/v1/db/tables", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch tables");
  }
  return result.data as TableListItem[];
}

/**
 * Fetch rows from a table (POST /v1/db/{table}/select).
 */
export async function fetchTableRows(
  tableName: string,
  apiKey: string,
  options?: {
    limit?: number;
    offset?: number;
    orderBy?: string;
    orderDir?: "asc" | "desc";
  },
): Promise<Record<string, unknown>[]> {
  const modifiers: Record<string, unknown> = {};
  if (options?.limit !== undefined) modifiers.limit = options.limit;
  if (options?.offset !== undefined) modifiers.offset = options.offset;
  if (options?.orderBy) modifiers.order_by = options.orderBy;
  if (options?.orderDir) modifiers.order_dir = options.orderDir;

  const result = await api.fetch(`/v1/db/${tableName}/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({
      columns: ["*"],
      filters: [],
      modifiers,
    }),
  });
  if (!result.ok) {
    throw new Error("Failed to fetch rows");
  }
  const data = result.data as SelectResponse;
  return data.data;
}

/**
 * Insert a row into a table (POST /v1/db/{table}/insert).
 */
export async function insertRow(
  tableName: string,
  row: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const result = await api.fetch(`/v1/db/${tableName}/insert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ rows: [row] }),
  });
  if (!result.ok) {
    throw new Error("Failed to insert row");
  }
  const data = result.data as { data: Record<string, unknown>[] };
  return data.data;
}

/**
 * Delete rows from a table (POST /v1/db/{table}/delete).
 */
export async function deleteRow(
  tableName: string,
  filters: Array<{ column: string; op: string; value: unknown }>,
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const result = await api.fetch(`/v1/db/${tableName}/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ filters }),
  });
  if (!result.ok) {
    throw new Error("Failed to delete row");
  }
  const data = result.data as { data: Record<string, unknown>[] };
  return data.data;
}

/**
 * Create a new table (POST /v1/db/tables).
 */
export async function createTable(
  apiKey: string,
  name: string,
  columns: Array<{
    name: string;
    data_type: string;
    sensitivity: string;
    is_owner: boolean;
  }>,
): Promise<TableListItem> {
  const result = await api.fetch("/v1/db/tables", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({
      name,
      columns: columns.map((c) => ({
        name: c.name,
        data_type: c.data_type,
        sensitivity: c.sensitivity,
        owner: c.is_owner,
      })),
    }),
  });
  if (!result.ok) {
    throw new Error("Failed to create table");
  }
  return result.data as TableListItem;
}

/**
 * Get row count for a table using select with limit 0.
 * We use a select with a large limit and count client-side, or
 * we can use the introspect endpoint which doesn't provide counts.
 * For now, we'll fetch all rows and count — the count endpoint isn't available.
 */
export async function fetchRowCount(
  tableName: string,
  apiKey: string,
): Promise<number> {
  const rows = await fetchTableRows(tableName, apiKey, { limit: 10000 });
  return rows.length;
}
