/**
 * Query builder for pqdb — produces request payloads for SELECT, INSERT, UPDATE, DELETE.
 *
 * All operations return { data, error } — never throw.
 */
import type { HttpClient } from "../client/http.js";
import type { PqdbResponse } from "../client/types.js";
import type { SchemaColumns, InferRow, TableSchema } from "./schema.js";
import { UuidColumnDef } from "./schema.js";
import type {
  FilterClause,
  FilterOp,
  OrderDirection,
  QueryModifiers,
} from "./types.js";
import type { CryptoContext } from "./crypto-context.js";
import {
  transformInsertRows,
  transformSelectResponse,
  transformFilters,
  transformFiltersMultiVersion,
  validateFilterOperations,
} from "./crypto-transform.js";

/** A function that returns the current user's ID, or null if not signed in. */
export type UserIdProvider = () => string | null;

/** Query operation type. */
type QueryOp = "select" | "insert" | "update" | "delete";

/**
 * Unwrap backend response envelope.
 *
 * The backend wraps all CRUD responses in `{"data": [...]}`.
 * If the response has this shape, return the inner array;
 * otherwise return the value as-is (for backwards compat with mocks).
 */
function unwrapDataEnvelope<T>(value: unknown): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "data" in (value as Record<string, unknown>)
  ) {
    return (value as Record<string, unknown>).data as T;
  }
  return value as T;
}

/**
 * Check whether a schema contains any sensitive (searchable or private) columns.
 */
function hasSensitiveColumns<S extends SchemaColumns>(schema: TableSchema<S>): boolean {
  return Object.values(schema.columns).some(
    (col) => col.sensitivity === "searchable" || col.sensitivity === "private",
  );
}

/**
 * Find the owner column name in a schema, if any.
 */
function findOwnerColumn<S extends SchemaColumns>(schema: TableSchema<S>): string | null {
  for (const [name, col] of Object.entries(schema.columns)) {
    if (col instanceof UuidColumnDef && col.isOwner) {
      return name;
    }
  }
  return null;
}

/**
 * Auto-set owner column on insert rows if not already provided.
 */
function applyOwnerColumn(
  rows: Record<string, unknown>[],
  ownerColumnName: string,
  userId: string,
): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row[ownerColumnName] !== undefined) {
      return row;
    }
    return { ...row, [ownerColumnName]: userId };
  });
}

/**
 * An executable query that has been configured with an operation, filters, and modifiers.
 */
class ExecutableQuery<Row, S extends SchemaColumns = SchemaColumns> {
  private readonly http: HttpClient;
  private readonly tableName: string;
  private readonly op: QueryOp;
  private readonly filters: FilterClause[];
  private readonly modifiers: QueryModifiers;
  private readonly payload: Record<string, unknown>;
  private readonly schema: TableSchema<S>;
  private readonly cryptoCtx: CryptoContext | null;
  private readonly getUserId: UserIdProvider | null;

  constructor(
    http: HttpClient,
    tableName: string,
    op: QueryOp,
    payload: Record<string, unknown>,
    schema: TableSchema<S>,
    cryptoCtx: CryptoContext | null,
    filters: FilterClause[] = [],
    modifiers: QueryModifiers = {},
    getUserId: UserIdProvider | null = null,
  ) {
    this.http = http;
    this.tableName = tableName;
    this.op = op;
    this.payload = payload;
    this.schema = schema;
    this.cryptoCtx = cryptoCtx;
    this.filters = filters;
    this.modifiers = modifiers;
    this.getUserId = getUserId;
  }

  /** Add an equals filter. */
  eq(col: string, value: unknown): ExecutableQuery<Row, S> {
    return this.addFilter(col, "eq", value);
  }

  /** Add a greater-than filter. */
  gt(col: string, value: unknown): ExecutableQuery<Row, S> {
    return this.addFilter(col, "gt", value);
  }

  /** Add a less-than filter. */
  lt(col: string, value: unknown): ExecutableQuery<Row, S> {
    return this.addFilter(col, "lt", value);
  }

  /** Add a greater-than-or-equal filter. */
  gte(col: string, value: unknown): ExecutableQuery<Row, S> {
    return this.addFilter(col, "gte", value);
  }

  /** Add a less-than-or-equal filter. */
  lte(col: string, value: unknown): ExecutableQuery<Row, S> {
    return this.addFilter(col, "lte", value);
  }

  /** Add an "in" filter (value must be in the given array). */
  in(col: string, values: unknown[]): ExecutableQuery<Row, S> {
    return this.addFilter(col, "in", values);
  }

  /** Set a row limit. */
  limit(n: number): ExecutableQuery<Row, S> {
    return new ExecutableQuery<Row, S>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.schema,
      this.cryptoCtx,
      this.filters,
      { ...this.modifiers, limit: n },
      this.getUserId,
    );
  }

  /** Set a row offset. */
  offset(n: number): ExecutableQuery<Row, S> {
    return new ExecutableQuery<Row, S>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.schema,
      this.cryptoCtx,
      this.filters,
      { ...this.modifiers, offset: n },
      this.getUserId,
    );
  }

  /** Set ordering. */
  order(col: string, direction: OrderDirection): ExecutableQuery<Row, S> {
    return new ExecutableQuery<Row, S>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.schema,
      this.cryptoCtx,
      this.filters,
      { ...this.modifiers, order: { column: col, direction } },
      this.getUserId,
    );
  }

  /** Execute the query against the backend. Returns { data, error } — never throws. */
  async execute(): Promise<PqdbResponse<Row[]>> {
    // Auto-set owner column on insert if applicable
    const payload = this.maybeApplyOwner(this.payload);

    const sensitive = hasSensitiveColumns(this.schema);

    // If no sensitive columns, skip all crypto transforms
    if (!sensitive) {
      const body = this.buildBody(this.filters, undefined, payload);
      const result = await this.http.request<Row[]>({
        method: "POST",
        path: `/v1/db/${this.tableName}/${this.op}`,
        body,
      });
      if (result.data) {
        return { data: unwrapDataEnvelope<Row[]>(result.data), error: null };
      }
      return result;
    }

    // Sensitive columns exist — require crypto context
    if (!this.cryptoCtx) {
      return {
        data: null,
        error: {
          code: "ENCRYPTION_ERROR",
          message:
            "encryptionKey is required when using tables with searchable or private columns",
        },
      };
    }

    try {
      // Validate filters before doing any work
      validateFilterOperations(this.filters, this.schema);

      // Fetch versioned HMAC keys
      const versionedKeys = await this.cryptoCtx.getVersionedHmacKeys();
      const currentKey = versionedKeys.keys[String(versionedKeys.currentVersion)];
      const keyPair = this.cryptoCtx.keyPair;

      // Transform based on operation
      let body: Record<string, unknown>;

      if (this.op === "insert") {
        const rows = payload.rows as Record<string, unknown>[];
        // Inserts always use current key version
        const transformedRows = await transformInsertRows(
          rows,
          this.schema,
          keyPair,
          currentKey,
          versionedKeys.currentVersion,
        );
        body = this.buildBody(this.filters, { rows: transformedRows });
      } else if (this.op === "update") {
        // Wrap update values as a single-element array, transform, unwrap
        const values = payload.values as Record<string, unknown>;
        const [transformedValues] = await transformInsertRows(
          [values],
          this.schema,
          keyPair,
          currentKey,
          versionedKeys.currentVersion,
        );
        // Filters use all versions to find rows indexed with any key
        const transformedFilters = transformFiltersMultiVersion(
          this.filters, this.schema, versionedKeys,
        );
        body = this.buildBody(transformedFilters, { values: transformedValues });
      } else {
        // select or delete — use all versions for filters
        const transformedFilters = transformFiltersMultiVersion(
          this.filters, this.schema, versionedKeys,
        );
        body = this.buildBody(transformedFilters);
      }

      const result = await this.http.request<Row[]>({
        method: "POST",
        path: `/v1/db/${this.tableName}/${this.op}`,
        body,
      });

      if (!result.data) return result;

      // Unwrap backend {data: [...]} envelope
      const rows = unwrapDataEnvelope<Row[]>(result.data);

      // Decrypt response for select
      if (this.op === "select") {
        const decryptedData = await transformSelectResponse(
          rows as unknown as Record<string, unknown>[],
          this.schema,
          keyPair.secretKey,
        );
        return { data: decryptedData as Row[], error: null };
      }

      return { data: rows, error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          code: "ENCRYPTION_ERROR",
          message: err instanceof Error ? err.message : "Encryption operation failed",
        },
      };
    }
  }

  /**
   * If this is an insert and the schema has an owner column,
   * auto-set the owner column to the current user's ID.
   */
  private maybeApplyOwner(payload: Record<string, unknown>): Record<string, unknown> {
    if (this.op !== "insert") return payload;

    const ownerCol = findOwnerColumn(this.schema);
    if (!ownerCol) return payload;

    const userId = this.getUserId?.();
    if (!userId) return payload;

    const rows = payload.rows as Record<string, unknown>[];
    return { ...payload, rows: applyOwnerColumn(rows, ownerCol, userId) };
  }

  private addFilter(col: string, op: FilterOp, value: unknown): ExecutableQuery<Row, S> {
    return new ExecutableQuery<Row, S>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.schema,
      this.cryptoCtx,
      [...this.filters, { column: col, op, value }],
      this.modifiers,
      this.getUserId,
    );
  }

  private buildBody(
    filters: FilterClause[],
    payloadOverride?: Record<string, unknown>,
    payloadBase?: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload = payloadOverride ?? payloadBase ?? this.payload;
    switch (this.op) {
      case "select":
        return {
          ...payload,
          filters,
          modifiers: this.modifiers,
        };
      case "insert":
        return { ...payload };
      case "update":
        return {
          ...payload,
          filters,
        };
      case "delete":
        return {
          filters,
        };
    }
  }
}

/**
 * QueryBuilder — entry point for building typed queries against a table.
 */
export class QueryBuilder<S extends SchemaColumns> {
  private readonly http: HttpClient;
  private readonly schema: TableSchema<S>;
  private readonly cryptoCtx: CryptoContext | null;
  private readonly getUserId: UserIdProvider | null;

  constructor(
    http: HttpClient,
    schema: TableSchema<S>,
    cryptoCtx?: CryptoContext | null,
    getUserId?: UserIdProvider | null,
  ) {
    this.http = http;
    this.schema = schema;
    this.cryptoCtx = cryptoCtx ?? null;
    this.getUserId = getUserId ?? null;
  }

  /** Build a SELECT query. Optionally specify columns to select. */
  select(...columns: (keyof S & string)[]): ExecutableQuery<InferRow<S>, S> {
    const cols = columns.length > 0 ? columns : ["*"];
    return new ExecutableQuery<InferRow<S>, S>(
      this.http,
      this.schema.name,
      "select",
      { columns: cols },
      this.schema,
      this.cryptoCtx,
      [],
      {},
      this.getUserId,
    );
  }

  /** Build an INSERT query with one or more rows. */
  insert(rows: Partial<InferRow<S>>[]): ExecutableQuery<InferRow<S>, S> {
    return new ExecutableQuery<InferRow<S>, S>(
      this.http,
      this.schema.name,
      "insert",
      { rows },
      this.schema,
      this.cryptoCtx,
      [],
      {},
      this.getUserId,
    );
  }

  /** Build an UPDATE query with values to set. */
  update(values: Partial<InferRow<S>>): ExecutableQuery<InferRow<S>, S> {
    return new ExecutableQuery<InferRow<S>, S>(
      this.http,
      this.schema.name,
      "update",
      { values },
      this.schema,
      this.cryptoCtx,
      [],
      {},
      this.getUserId,
    );
  }

  /** Build a DELETE query. */
  delete(): ExecutableQuery<InferRow<S>, S> {
    return new ExecutableQuery<InferRow<S>, S>(
      this.http,
      this.schema.name,
      "delete",
      {},
      this.schema,
      this.cryptoCtx,
      [],
      {},
      this.getUserId,
    );
  }
}
