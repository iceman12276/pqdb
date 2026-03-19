/**
 * Query builder helpers and API functions for the Query Playground.
 * Calls POST /v1/db/{table}/select via the authenticated API client.
 */

import { api } from "./api-client";

export interface QueryFilter {
  column: string;
  op: string;
  value: string;
}

export interface QueryModifiers {
  limit?: number;
  offset?: number;
  order_by?: string;
  order_dir?: string;
}

export interface QueryPayload {
  columns: string[];
  filters: QueryFilter[];
  modifiers: QueryModifiers;
}

export interface QueryResult {
  data?: Record<string, unknown>[];
  error?: string;
}

export interface BuildQueryOptions {
  table: string;
  columns: string[];
  filters: QueryFilter[];
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: string;
}

export function buildQueryPayload(options: BuildQueryOptions): QueryPayload {
  const modifiers: QueryModifiers = {};
  if (options.limit !== undefined) modifiers.limit = options.limit;
  if (options.offset !== undefined) modifiers.offset = options.offset;
  if (options.orderBy !== undefined) modifiers.order_by = options.orderBy;
  if (options.orderDir !== undefined) modifiers.order_dir = options.orderDir;

  return {
    columns: options.columns.length > 0 ? options.columns : ["*"],
    filters: options.filters,
    modifiers,
  };
}

export async function executeQuery(
  table: string,
  payload: QueryPayload,
  apiKey: string,
): Promise<QueryResult> {
  try {
    const result = await api.fetch(`/v1/db/${table}/select`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!result.ok) {
      const errorData = result.data as {
        error?: { message?: string };
        detail?: string;
      } | null;
      const message =
        errorData?.error?.message ?? errorData?.detail ?? "Query failed";
      return { error: message };
    }

    const data = result.data as { data: Record<string, unknown>[] };
    return { data: data.data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Query failed" };
  }
}
