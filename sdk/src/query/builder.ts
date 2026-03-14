/**
 * Query builder for pqdb — produces request payloads for SELECT, INSERT, UPDATE, DELETE.
 *
 * All operations return { data, error } — never throw.
 */
import type { HttpClient } from "../client/http.js";
import type { PqdbResponse } from "../client/types.js";
import type { SchemaColumns, InferRow, TableSchema } from "./schema.js";
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
  validateFilterOperations,
} from "./crypto-transform.js";

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

  constructor(
    http: HttpClient,
    tableName: string,
    op: QueryOp,
    payload: Record<string, unknown>,
    schema: TableSchema<S>,
    cryptoCtx: CryptoContext | null,
    filters: FilterClause[] = [],
    modifiers: QueryModifiers = {},
  ) {
    this.http = http;
    this.tableName = tableName;
    this.op = op;
    this.payload = payload;
    this.schema = schema;
    this.cryptoCtx = cryptoCtx;
    this.filters = filters;
    this.modifiers = modifiers;
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
    );
  }

  /** Execute the query against the backend. Returns { data, error } — never throws. */
  async execute(): Promise<PqdbResponse<Row[]>> {
    const sensitive = hasSensitiveColumns(this.schema);

    // If no sensitive columns, skip all crypto transforms
    if (!sensitive) {
      const body = this.buildBody(this.filters);
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

      // Ensure HMAC key is available
      const hmacKey = await this.cryptoCtx.getHmacKey();
      const keyPair = this.cryptoCtx.keyPair;

      // Transform based on operation
      let body: Record<string, unknown>;

      if (this.op === "insert") {
        const rows = this.payload.rows as Record<string, unknown>[];
        const transformedRows = await transformInsertRows(
          rows,
          this.schema,
          keyPair,
          hmacKey,
        );
        body = this.buildBody(this.filters, { rows: transformedRows });
      } else if (this.op === "update") {
        // Wrap update values as a single-element array, transform, unwrap
        const values = this.payload.values as Record<string, unknown>;
        const [transformedValues] = await transformInsertRows(
          [values],
          this.schema,
          keyPair,
          hmacKey,
        );
        const transformedFilters = transformFilters(this.filters, this.schema, hmacKey);
        body = this.buildBody(transformedFilters, { values: transformedValues });
      } else {
        // select or delete — just transform filters
        const transformedFilters = transformFilters(this.filters, this.schema, hmacKey);
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
    );
  }

  private buildBody(
    filters: FilterClause[],
    payloadOverride?: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload = payloadOverride ?? this.payload;
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

  constructor(http: HttpClient, schema: TableSchema<S>, cryptoCtx?: CryptoContext | null) {
    this.http = http;
    this.schema = schema;
    this.cryptoCtx = cryptoCtx ?? null;
  }

  /** Build a SELECT query. Optionally specify columns to select. */
  select(...columns: (keyof S & string)[]): ExecutableQuery<InferRow<S>, S> {
    const cols = columns.length > 0 ? columns : "*";
    return new ExecutableQuery<InferRow<S>, S>(
      this.http,
      this.schema.name,
      "select",
      { columns: cols },
      this.schema,
      this.cryptoCtx,
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
    );
  }
}
