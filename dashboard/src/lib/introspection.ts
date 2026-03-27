/**
 * Introspection API functions for catalog endpoints.
 * Calls GET /v1/db/catalog/* via the authenticated API client with project apikey header.
 */

import { api } from "./api-client";

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
