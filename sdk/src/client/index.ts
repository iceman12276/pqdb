/**
 * Client module — createClient factory and PqdbClient.
 */
import { HttpClient } from "./http.js";
import { AuthClient } from "./auth.js";
import { RealtimeClient } from "./realtime.js";
import { QueryBuilder } from "../query/builder.js";
import { defineTableSchema } from "../query/schema.js";
import { deriveKeyPair, decrypt } from "../crypto/encryption.js";
import { computeBlindIndex } from "../crypto/blind-index.js";
import { transformSelectResponse } from "../query/crypto-transform.js";
import type { SchemaColumns, TableSchema } from "../query/schema.js";
import type { PqdbClientOptions, PqdbResponse } from "./types.js";
import type { CryptoContext } from "../query/crypto-context.js";
import type { KeyPair } from "../crypto/pqc.js";
import type { VersionedHmacKeys } from "../crypto/blind-index.js";

/** Result returned by client.reindex(). */
export interface ReindexResult {
  jobId: string;
  tablesProcessed: number;
  rowsUpdated: number;
}

export interface PqdbClient {
  auth: AuthClient;
  realtime: RealtimeClient;

  /** Define a table schema for use with the query builder. */
  defineTable<S extends SchemaColumns>(name: string, columns: S): TableSchema<S>;

  /** Create a query builder for the given table schema. */
  from<S extends SchemaColumns>(schema: TableSchema<S>): QueryBuilder<S>;

  /**
   * SDK-driven re-indexing after HMAC key rotation.
   *
   * 1. Starts a re-index job on the server to get tables needing re-indexing
   * 2. For each table, fetches all rows
   * 3. Decrypts encrypted values to recover plaintext
   * 4. Re-computes HMAC(new_key, plaintext) blind indexes
   * 5. Sends updated indexes back to the server
   *
   * Requires: JWT auth token set on the client, encryptionKey in client options.
   * @param projectId - The project UUID to re-index
   */
  reindex(projectId: string): Promise<PqdbResponse<ReindexResult>>;
}

/**
 * Parse an HMAC key hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Decode base64 string back to Uint8Array. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Response shape from /v1/db/hmac-key (versioned). */
interface HmacKeyVersionedResponse {
  current_version: number;
  keys: Record<string, string>; // version -> hex key
}

/** Response from POST /v1/projects/{id}/reindex */
interface StartReindexResponse {
  job_id: string;
  tables: Array<{
    table: string;
    searchable_columns: string[];
  }>;
}

/** Response from POST /v1/db/{table}/select */
interface SelectResponse {
  data: Array<Record<string, unknown>>;
}

/** Response from POST /v1/projects/{id}/reindex/batch */
interface BatchResponse {
  rows_updated: number;
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
  const auth = new AuthClient(http, options?.projectId);

  // Build decryptRow function for realtime if encryption key is provided
  const decryptRowFn = options?.encryptionKey
    ? async (row: Record<string, unknown>, schema: TableSchema): Promise<Record<string, unknown>> => {
        const ctx = await getResolvedCryptoContext();
        const [decrypted] = await transformSelectResponse([row], schema, ctx.keyPair.secretKey);
        return decrypted;
      }
    : null;

  const realtime = new RealtimeClient({
    baseUrl: projectUrl,
    apiKey,
    token: http.getAccessToken(),
    decryptRow: decryptRowFn,
  });

  // One-time warning about encryption key backup responsibility
  if (options?.encryptionKey) {
    console.warn(
      "[pqdb] Your encryption key is never sent to the server. " +
      "If you lose this key, your encrypted data is permanently unrecoverable. " +
      "Store it securely (password manager, secure vault, or offline backup).",
    );
  }

  // Crypto state — lazily initialized
  let resolvedCryptoCtx: CryptoContext | null = null;
  let cryptoCtxPromise: Promise<CryptoContext> | null = null;
  let cachedVersionedKeys: VersionedHmacKeys | null = null;

  async function fetchVersionedHmacKeys(): Promise<VersionedHmacKeys> {
    if (cachedVersionedKeys) return cachedVersionedKeys;

    const result = await http.request<HmacKeyVersionedResponse>({
      method: "GET",
      path: "/v1/db/hmac-key",
    });

    if (result.error) {
      throw new Error(`Failed to retrieve HMAC keys: ${result.error.message}`);
    }

    const data = result.data!;
    const keys: Record<string, Uint8Array> = {};
    for (const [ver, hex] of Object.entries(data.keys)) {
      keys[ver] = hexToBytes(hex);
    }

    cachedVersionedKeys = {
      currentVersion: data.current_version,
      keys,
    };
    return cachedVersionedKeys;
  }

  async function getResolvedCryptoContext(): Promise<CryptoContext> {
    if (resolvedCryptoCtx) return resolvedCryptoCtx;

    if (!cryptoCtxPromise) {
      cryptoCtxPromise = (async () => {
        const keyPair = await deriveKeyPair(options!.encryptionKey!);
        const ctx: CryptoContext = {
          keyPair,
          getHmacKey: async () => {
            const versioned = await fetchVersionedHmacKeys();
            return versioned.keys[String(versioned.currentVersion)];
          },
          getVersionedHmacKeys: fetchVersionedHmacKeys,
        };
        resolvedCryptoCtx = ctx;
        return ctx;
      })();
    }

    return cryptoCtxPromise;
  }

  function defineTable<S extends SchemaColumns>(name: string, columns: S): TableSchema<S> {
    return defineTableSchema(name, columns);
  }

  /** User ID provider — returns current user ID or null. */
  function getUserId(): string | null {
    return auth.users.getUserId();
  }

  function from<S extends SchemaColumns>(schema: TableSchema<S>): QueryBuilder<S> {
    if (!options?.encryptionKey) {
      return new QueryBuilder(http, schema, null, getUserId);
    }

    // Lazy CryptoContext: key pair is derived on first async use
    const lazyCryptoCtx: CryptoContext = {
      get keyPair(): KeyPair {
        if (resolvedCryptoCtx) return resolvedCryptoCtx.keyPair;
        throw new Error("CryptoContext not yet initialized — call getHmacKey() first");
      },
      getHmacKey: async () => {
        const ctx = await getResolvedCryptoContext();
        return ctx.getHmacKey();
      },
      getVersionedHmacKeys: async () => {
        const ctx = await getResolvedCryptoContext();
        return ctx.getVersionedHmacKeys();
      },
    };

    return new QueryBuilder(http, schema, lazyCryptoCtx, getUserId);
  }

  async function reindex(projectId: string): Promise<PqdbResponse<ReindexResult>> {
    if (!options?.encryptionKey) {
      return {
        data: null,
        error: {
          code: "ENCRYPTION_ERROR",
          message: "encryptionKey is required for re-indexing",
        },
      };
    }

    try {
      // Ensure crypto context is initialized
      const cryptoCtx = await getResolvedCryptoContext();

      // Clear cached keys so we get fresh ones after rotation
      cachedVersionedKeys = null;
      const versionedKeys = await fetchVersionedHmacKeys();
      const currentVersion = versionedKeys.currentVersion;
      const currentKey = versionedKeys.keys[String(currentVersion)];

      // Step 1: Start the reindex job on the server
      const startResult = await http.request<StartReindexResponse>({
        method: "POST",
        path: `/v1/projects/${projectId}/reindex`,
      });

      if (startResult.error) {
        return {
          data: null,
          error: startResult.error,
        };
      }

      const { job_id: jobId, tables } = startResult.data!;

      // If no tables need re-indexing, we're done
      if (tables.length === 0) {
        return {
          data: { jobId, tablesProcessed: 0, rowsUpdated: 0 },
          error: null,
        };
      }

      let totalRowsUpdated = 0;
      let tablesProcessed = 0;

      // Step 2: For each table, fetch rows, decrypt, re-compute, send batch
      for (const tableInfo of tables) {
        const { table, searchable_columns: searchableColumns } = tableInfo;

        // Fetch all rows from this table
        const selectResult = await http.request<SelectResponse>({
          method: "POST",
          path: `/v1/db/${table}/select`,
          body: { columns: ["*"] },
        });

        if (selectResult.error) {
          // Mark job as failed and return error
          await http.request({
            method: "POST",
            path: `/v1/projects/${projectId}/reindex/complete`,
            body: { job_id: jobId, tables_done: tablesProcessed },
          });
          return {
            data: null,
            error: selectResult.error,
          };
        }

        const rows = selectResult.data!.data ?? selectResult.data! as unknown as Record<string, unknown>[];
        const batchUpdates: Array<{ id: string; indexes: Record<string, string> }> = [];

        for (const row of rows as Record<string, unknown>[]) {
          const rowId = row["id"] as string;
          const indexes: Record<string, string> = {};

          for (const col of searchableColumns) {
            const encryptedKey = `${col}_encrypted`;
            const indexKey = `${col}_index`;
            const encryptedValue = row[encryptedKey] as string | undefined;
            const currentIndex = row[indexKey] as string | undefined;

            // Skip if already on current version
            if (currentIndex?.startsWith(`v${currentVersion}:`)) {
              continue;
            }

            if (encryptedValue) {
              // Decrypt the encrypted value to get plaintext
              const ciphertext = fromBase64(encryptedValue);
              const plaintext = await decrypt(ciphertext, cryptoCtx.keyPair.secretKey);

              // Re-compute blind index with current HMAC key
              const newIndex = computeBlindIndex(plaintext, currentKey, currentVersion);
              indexes[indexKey] = newIndex;
            }
          }

          if (Object.keys(indexes).length > 0) {
            batchUpdates.push({ id: rowId, indexes });
          }
        }

        // Send batch update if there are any
        if (batchUpdates.length > 0) {
          const batchResult = await http.request<BatchResponse>({
            method: "POST",
            path: `/v1/projects/${projectId}/reindex/batch`,
            body: {
              job_id: jobId,
              table,
              updates: batchUpdates,
            },
          });

          if (batchResult.error) {
            return {
              data: null,
              error: batchResult.error,
            };
          }

          totalRowsUpdated += batchResult.data!.rows_updated;
        }

        tablesProcessed++;
      }

      // Step 3: Mark job as complete
      await http.request({
        method: "POST",
        path: `/v1/projects/${projectId}/reindex/complete`,
        body: { job_id: jobId, tables_done: tablesProcessed },
      });

      return {
        data: {
          jobId,
          tablesProcessed,
          rowsUpdated: totalRowsUpdated,
        },
        error: null,
      };
    } catch (err) {
      return {
        data: null,
        error: {
          code: "REINDEX_ERROR",
          message: err instanceof Error ? err.message : "Re-indexing failed",
        },
      };
    }
  }

  return { auth, realtime, defineTable, from, reindex };
}

export type { PqdbClientOptions, PqdbClient as PqdbClientInterface };
