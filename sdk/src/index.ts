/**
 * @pqdb/client — TypeScript SDK for pqdb
 *
 * Post-quantum encrypted database client with zero-knowledge architecture.
 */

export const VERSION = "0.1.0";

export { createClient } from "./client/index.js";
export type { PqdbClient, PqdbClientOptions } from "./client/index.js";
export type {
  AuthCredentials,
  AuthTokens,
  AuthResponse,
  PqdbError,
  PqdbResponse,
} from "./client/types.js";
export { AuthClient } from "./client/auth.js";
