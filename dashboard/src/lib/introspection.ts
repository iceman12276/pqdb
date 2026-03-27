/**
 * API functions for catalog introspection endpoints (US-096).
 * Calls GET /v1/db/catalog/functions and GET /v1/db/catalog/triggers
 * via the authenticated API client with project apikey header.
 */

import { api } from "./api-client";

export interface CatalogFunction {
  name: string;
  schema: string;
  args: string;
  return_type: string;
  language: string;
  source: string;
}

export interface CatalogTrigger {
  name: string;
  table: string;
  timing: string;
  events: string[];
  function_name: string;
}

export async function fetchFunctions(
  apiKey: string,
): Promise<CatalogFunction[]> {
  const result = await api.fetch("/v1/db/catalog/functions", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch functions");
  }
  return result.data as CatalogFunction[];
}

export async function fetchTriggers(
  apiKey: string,
): Promise<CatalogTrigger[]> {
  const result = await api.fetch("/v1/db/catalog/triggers", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch triggers");
  }
  return result.data as CatalogTrigger[];
}
