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

// --- Index types ---

export interface IndexInfo {
  name: string;
  table: string;
  definition: string;
  unique: boolean;
  size_bytes: number;
}

export async function fetchIndexes(apiKey: string): Promise<IndexInfo[]> {
  const result = await api.fetch("/v1/db/catalog/indexes", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch indexes");
  }
  return result.data as IndexInfo[];
}

// --- Publication types ---

export interface PublicationInfo {
  name: string;
  all_tables: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  tables: string[];
}

export async function fetchPublications(
  apiKey: string,
): Promise<PublicationInfo[]> {
  const result = await api.fetch("/v1/db/catalog/publications", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch publications");
  }
  return result.data as PublicationInfo[];
}

// --- Replication types (US-106) ---

export interface ReplicationSlot {
  slot_name: string;
  slot_type: string;
  active: boolean;
  restart_lsn: string | null;
  confirmed_flush_lsn: string | null;
}

export interface ReplicationStat {
  client_addr: string | null;
  state: string;
  sent_lsn: string | null;
  write_lsn: string | null;
  replay_lsn: string | null;
  replay_lag: string | null;
}

export interface ReplicationInfo {
  slots: ReplicationSlot[];
  stats: ReplicationStat[];
}

export async function fetchReplication(
  apiKey: string,
): Promise<ReplicationInfo> {
  const result = await api.fetch("/v1/db/catalog/replication", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch replication status");
  }
  return result.data as ReplicationInfo;
}
