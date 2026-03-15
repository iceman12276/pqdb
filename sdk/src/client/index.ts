/**
 * Client module — createClient factory and PqdbClient.
 */
import { HttpClient } from "./http.js";
import { AuthClient } from "./auth.js";
import { QueryBuilder } from "../query/builder.js";
import { defineTableSchema } from "../query/schema.js";
import { deriveKeyPair } from "../crypto/encryption.js";
import type { SchemaColumns, TableSchema } from "../query/schema.js";
import type { PqdbClientOptions } from "./types.js";
import type { CryptoContext } from "../query/crypto-context.js";
import type { KeyPair } from "../crypto/pqc.js";
import type { VersionedHmacKeys } from "../crypto/blind-index.js";

export interface PqdbClient {
  auth: AuthClient;

  /** Define a table schema for use with the query builder. */
  defineTable<S extends SchemaColumns>(name: string, columns: S): TableSchema<S>;

  /** Create a query builder for the given table schema. */
  from<S extends SchemaColumns>(schema: TableSchema<S>): QueryBuilder<S>;
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

/** Response shape from /v1/db/hmac-key (versioned). */
interface HmacKeyVersionedResponse {
  current_version: number;
  keys: Record<string, string>; // version -> hex key
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
  const auth = new AuthClient(http);

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

  function from<S extends SchemaColumns>(schema: TableSchema<S>): QueryBuilder<S> {
    if (!options?.encryptionKey) {
      return new QueryBuilder(http, schema, null);
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

    return new QueryBuilder(http, schema, lazyCryptoCtx);
  }

  return { auth, defineTable, from };
}

export type { PqdbClientOptions, PqdbClient as PqdbClientInterface };
