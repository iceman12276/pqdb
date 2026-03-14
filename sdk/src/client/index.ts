/**
 * Client module — createClient factory and PqdbClient.
 */
import { HttpClient } from "./http.js";
import { AuthClient } from "./auth.js";
import { QueryBuilder } from "../query/builder.js";
import { defineTableSchema } from "../query/schema.js";
import type { SchemaColumns, TableSchema } from "../query/schema.js";
import type { PqdbClientOptions } from "./types.js";

export interface PqdbClient {
  auth: AuthClient;

  /** Define a table schema for use with the query builder. */
  defineTable<S extends SchemaColumns>(name: string, columns: S): TableSchema<S>;

  /** Create a query builder for the given table schema. */
  from<S extends SchemaColumns>(schema: TableSchema<S>): QueryBuilder<S>;
}

/**
 * Create a pqdb client instance.
 *
 * @param projectUrl - Base URL of the pqdb API server
 * @param apiKey - Project API key (sent as `apikey` header on all requests)
 * @param options - Optional client configuration
 */
export function createClient(
  projectUrl: string,
  apiKey: string,
  options?: PqdbClientOptions,
): PqdbClient {
  const http = new HttpClient(projectUrl, apiKey);

  // encryptionKey is stored for future use by query/crypto modules.
  // It is never transmitted to the server.
  const _encryptionKey = options?.encryptionKey;

  const auth = new AuthClient(http);

  function defineTable<S extends SchemaColumns>(name: string, columns: S): TableSchema<S> {
    return defineTableSchema(name, columns);
  }

  function from<S extends SchemaColumns>(schema: TableSchema<S>): QueryBuilder<S> {
    return new QueryBuilder(http, schema);
  }

  return { auth, defineTable, from };
}

export type { PqdbClientOptions, PqdbClient as PqdbClientInterface };
