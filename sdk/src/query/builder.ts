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

/** Query operation type. */
type QueryOp = "select" | "insert" | "update" | "delete";

/**
 * An executable query that has been configured with an operation, filters, and modifiers.
 */
class ExecutableQuery<Row> {
  private readonly http: HttpClient;
  private readonly tableName: string;
  private readonly op: QueryOp;
  private readonly filters: FilterClause[];
  private readonly modifiers: QueryModifiers;
  private readonly payload: Record<string, unknown>;

  constructor(
    http: HttpClient,
    tableName: string,
    op: QueryOp,
    payload: Record<string, unknown>,
    filters: FilterClause[] = [],
    modifiers: QueryModifiers = {},
  ) {
    this.http = http;
    this.tableName = tableName;
    this.op = op;
    this.payload = payload;
    this.filters = filters;
    this.modifiers = modifiers;
  }

  /** Add an equals filter. */
  eq(col: string, value: unknown): ExecutableQuery<Row> {
    return this.addFilter(col, "eq", value);
  }

  /** Add a greater-than filter. */
  gt(col: string, value: unknown): ExecutableQuery<Row> {
    return this.addFilter(col, "gt", value);
  }

  /** Add a less-than filter. */
  lt(col: string, value: unknown): ExecutableQuery<Row> {
    return this.addFilter(col, "lt", value);
  }

  /** Add a greater-than-or-equal filter. */
  gte(col: string, value: unknown): ExecutableQuery<Row> {
    return this.addFilter(col, "gte", value);
  }

  /** Add a less-than-or-equal filter. */
  lte(col: string, value: unknown): ExecutableQuery<Row> {
    return this.addFilter(col, "lte", value);
  }

  /** Add an "in" filter (value must be in the given array). */
  in(col: string, values: unknown[]): ExecutableQuery<Row> {
    return this.addFilter(col, "in", values);
  }

  /** Set a row limit. */
  limit(n: number): ExecutableQuery<Row> {
    return new ExecutableQuery<Row>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.filters,
      { ...this.modifiers, limit: n },
    );
  }

  /** Set a row offset. */
  offset(n: number): ExecutableQuery<Row> {
    return new ExecutableQuery<Row>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.filters,
      { ...this.modifiers, offset: n },
    );
  }

  /** Set ordering. */
  order(col: string, direction: OrderDirection): ExecutableQuery<Row> {
    return new ExecutableQuery<Row>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      this.filters,
      { ...this.modifiers, order: { column: col, direction } },
    );
  }

  /** Execute the query against the backend. Returns { data, error } — never throws. */
  async execute(): Promise<PqdbResponse<Row[]>> {
    const body = this.buildBody();
    return this.http.request<Row[]>({
      method: "POST",
      path: `/v1/db/${this.tableName}/${this.op}`,
      body,
    });
  }

  private addFilter(col: string, op: FilterOp, value: unknown): ExecutableQuery<Row> {
    return new ExecutableQuery<Row>(
      this.http,
      this.tableName,
      this.op,
      this.payload,
      [...this.filters, { column: col, op, value }],
      this.modifiers,
    );
  }

  private buildBody(): Record<string, unknown> {
    switch (this.op) {
      case "select":
        return {
          ...this.payload,
          filters: this.filters,
          modifiers: this.modifiers,
        };
      case "insert":
        return { ...this.payload };
      case "update":
        return {
          ...this.payload,
          filters: this.filters,
        };
      case "delete":
        return {
          filters: this.filters,
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

  constructor(http: HttpClient, schema: TableSchema<S>) {
    this.http = http;
    this.schema = schema;
  }

  /** Build a SELECT query. Optionally specify columns to select. */
  select(...columns: (keyof S & string)[]): ExecutableQuery<InferRow<S>> {
    const cols = columns.length > 0 ? columns : "*";
    return new ExecutableQuery<InferRow<S>>(
      this.http,
      this.schema.name,
      "select",
      { columns: cols },
    );
  }

  /** Build an INSERT query with one or more rows. */
  insert(rows: Partial<InferRow<S>>[]): ExecutableQuery<InferRow<S>> {
    return new ExecutableQuery<InferRow<S>>(
      this.http,
      this.schema.name,
      "insert",
      { rows },
    );
  }

  /** Build an UPDATE query with values to set. */
  update(values: Partial<InferRow<S>>): ExecutableQuery<InferRow<S>> {
    return new ExecutableQuery<InferRow<S>>(
      this.http,
      this.schema.name,
      "update",
      { values },
    );
  }

  /** Build a DELETE query. */
  delete(): ExecutableQuery<InferRow<S>> {
    return new ExecutableQuery<InferRow<S>>(
      this.http,
      this.schema.name,
      "delete",
      {},
    );
  }
}
