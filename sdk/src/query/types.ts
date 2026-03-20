/**
 * TypeScript types for query builder payloads.
 */

/** Filter operator types. */
export type FilterOp = "eq" | "gt" | "lt" | "gte" | "lte" | "in";

/** A single filter clause. */
export interface FilterClause {
  column: string;
  op: FilterOp;
  value: unknown;
}

/** Order direction. */
export type OrderDirection = "asc" | "desc";

/** Distance metric for vector similarity search. */
export type DistanceMetric = "cosine" | "l2" | "inner_product";

/** Options for .similarTo() vector search. */
export interface SimilarToOptions {
  limit: number;
  distance?: DistanceMetric;
}

/** Vector similarity search clause sent to the backend. */
export interface SimilarToClause {
  column: string;
  vector: number[];
  limit: number;
  distance: DistanceMetric;
}

/** Query modifiers (limit, offset, order). */
export interface QueryModifiers {
  limit?: number;
  offset?: number;
  order?: { column: string; direction: OrderDirection };
}

/** SELECT query payload. */
export interface SelectPayload {
  columns: string[] | "*";
  filters: FilterClause[];
  modifiers: QueryModifiers;
  similar_to?: SimilarToClause;
}

/** INSERT query payload. */
export interface InsertPayload {
  rows: Record<string, unknown>[];
}

/** UPDATE query payload. */
export interface UpdatePayload {
  values: Record<string, unknown>;
  filters: FilterClause[];
}

/** DELETE query payload. */
export interface DeletePayload {
  filters: FilterClause[];
}
