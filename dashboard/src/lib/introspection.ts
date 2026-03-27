/**
 * Fetch functions for Postgres catalog introspection endpoints (US-096).
 * Used by the Indexes and Publications dashboard pages.
 */

export interface IndexInfo {
  name: string;
  table: string;
  definition: string;
  unique: boolean;
  size_bytes: number;
}

export interface PublicationInfo {
  name: string;
  all_tables: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  tables: string[];
}

export async function fetchIndexes(apiKey: string): Promise<IndexInfo[]> {
  const res = await fetch("/v1/db/catalog/indexes", {
    headers: { apikey: apiKey },
  });
  if (!res.ok) {
    throw new Error("Failed to fetch indexes");
  }
  return res.json();
}

export async function fetchPublications(
  apiKey: string,
): Promise<PublicationInfo[]> {
  const res = await fetch("/v1/db/catalog/publications", {
    headers: { apikey: apiKey },
  });
  if (!res.ok) {
    throw new Error("Failed to fetch publications");
  }
  return res.json();
}
