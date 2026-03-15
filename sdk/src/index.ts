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
  UserProfile,
  UserAuthTokens,
  UserAuthResponse,
  UserMetadataUpdate,
  PqdbError,
  PqdbResponse,
} from "./client/types.js";
export { AuthClient } from "./client/auth.js";
export { UserAuthClient } from "./client/user-auth.js";

// Query builder exports
export { column, defineTableSchema, ColumnDef } from "./query/schema.js";
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
