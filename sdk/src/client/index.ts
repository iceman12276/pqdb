/**
 * Client module — createClient factory and PqdbClient.
 */
import { HttpClient } from "./http.js";
import { AuthClient } from "./auth.js";
import type { PqdbClientOptions } from "./types.js";

export interface PqdbClient {
  auth: AuthClient;
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

  return { auth };
}

export type { PqdbClientOptions, PqdbClient as PqdbClientInterface };
