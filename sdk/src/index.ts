/**
 * @pqdb/client — TypeScript SDK for pqdb
 *
 * Post-quantum encrypted database client with zero-knowledge architecture.
 */

export const VERSION = "0.1.0";

export { createClient } from "./client/index.js";
export type { PqdbClient, PqdbClientOptions, ReindexResult } from "./client/index.js";
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
} from "./query/types.js";
