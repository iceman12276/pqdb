/**
 * @pqdb/client — TypeScript SDK for pqdb
 *
 * Post-quantum encrypted database client with zero-knowledge architecture.
 */

export const VERSION = "0.1.0";

export { createClient } from "./client/index.js";
export type { PqdbClient, PqdbClientOptions, ReindexResult } from "./client/index.js";
export { RealtimeClient } from "./client/realtime.js";
export type {
  RealtimeEvent,
  RealtimeEventType,
  RealtimeCallback,
  Subscription,
} from "./client/realtime.js";
export type {
  AuthCredentials,
  AuthTokens,
  AuthResponse,
  UserProfile,
  UserAuthTokens,
  UserAuthResponse,
  UserMetadataUpdate,
  PqdbError,
  PqdbResponse,
  CreateRoleRequest,
  Role,
  CreatePolicyRequest,
  Policy,
  MfaEnrollResponse,
  MfaVerifyRequest,
  MfaChallengeRequest,
  MfaUnenrollRequest,
  MfaRequiredResponse,
  SetRoleResponse,
} from "./client/types.js";
export { AuthClient } from "./client/auth.js";
export { UserAuthClient } from "./client/user-auth.js";
export { RolesClient } from "./client/roles.js";
export { PoliciesClient } from "./client/policies.js";
export { MfaClient } from "./client/mfa.js";

// Crypto exports (for MCP server and other consumers that need direct access)
export { deriveKeyPair, encrypt, decrypt } from "./crypto/encryption.js";
export type { KeyPair } from "./crypto/pqc.js";
export { computeBlindIndex } from "./crypto/blind-index.js";
export {
  transformInsertRows,
  transformSelectResponse,
  transformFilters,
} from "./query/crypto-transform.js";

// Query builder exports
export { column, defineTableSchema, ColumnDef, UuidColumnDef } from "./query/schema.js";
export type {
  Sensitivity,
  ColumnType,
  SchemaColumns,
  InferRow,
  TableSchema,
} from "./query/schema.js";
export { QueryBuilder } from "./query/builder.js";
export type {
  FilterOp,
  FilterClause,
  OrderDirection,
  QueryModifiers,
  DistanceMetric,
  SimilarToOptions,
  SimilarToClause,
} from "./query/types.js";
