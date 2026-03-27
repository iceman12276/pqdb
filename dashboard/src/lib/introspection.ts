/**
 * Introspection API functions for catalog endpoints.
 * Calls GET /v1/db/catalog/* via the authenticated API client with project apikey header.
 */

import { api } from "./api-client";

// --- Function types ---

export interface CatalogFunction {
  name: string;
  schema: string;
  args: string;
  return_type: string;
  language: string;
  source: string;
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

// --- Trigger types ---

export interface CatalogTrigger {
  name: string;
  table: string;
  timing: string;
  events: string[];
  function_name: string;
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

// --- Enum types ---

export interface EnumType {
  name: string;
  schema: string;
  values: string[];
}

export async function fetchEnums(apiKey: string): Promise<EnumType[]> {
  const result = await api.fetch("/v1/db/catalog/enums", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch enums");
  }
  return result.data as EnumType[];
}

// --- Extension types ---

export interface Extension {
  name: string;
  version: string;
  schema: string;
  comment: string | null;
}

export async function fetchExtensions(apiKey: string): Promise<Extension[]> {
  const result = await api.fetch("/v1/db/catalog/extensions", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch extensions");
  }
  return result.data as Extension[];
}
