/**
 * Column definitions and table schema for pqdb query builder.
 */

/** Sensitivity levels for columns. */
export type Sensitivity = "plain" | "searchable" | "private";

/** Column data types. */
export type ColumnType =
  | "uuid"
  | "text"
  | "integer"
  | "timestamp"
  | "boolean"
  | "vector";

/** A column definition with fluent chaining. */
export class ColumnDef<T = unknown> {
  readonly type: ColumnType;
  readonly sensitivity: Sensitivity;
  readonly isPrimaryKey: boolean;
  readonly dimensions?: number;

  constructor(
    type: ColumnType,
    sensitivity: Sensitivity = "plain",
    isPrimaryKey: boolean = false,
    dimensions?: number,
  ) {
    this.type = type;
    this.sensitivity = sensitivity;
    this.isPrimaryKey = isPrimaryKey;
    this.dimensions = dimensions;
  }

  /** Mark this column with a sensitivity level. */
  sensitive(level: "searchable" | "private"): ColumnDef<T> {
    return new ColumnDef<T>(this.type, level, this.isPrimaryKey, this.dimensions);
  }

  /** Mark this column as the primary key. */
  primaryKey(): ColumnDef<T> {
    return new ColumnDef<T>(this.type, this.sensitivity, true, this.dimensions);
  }
}

/** TypeScript type mapping from column type to native type. */
export type InferColumnType<C> = C extends ColumnDef<infer T> ? T : never;

/** Column factory helpers. */
export const column = {
  uuid(): ColumnDef<string> {
    return new ColumnDef<string>("uuid");
  },
  text(): ColumnDef<string> {
    return new ColumnDef<string>("text");
  },
  integer(): ColumnDef<number> {
    return new ColumnDef<number>("integer");
  },
  timestamp(): ColumnDef<string> {
    return new ColumnDef<string>("timestamp");
  },
  boolean(): ColumnDef<boolean> {
    return new ColumnDef<boolean>("boolean");
  },
  vector(dimensions: number): ColumnDef<number[]> {
    return new ColumnDef<number[]>("vector", "plain", false, dimensions);
  },
};

/** A record of column name to column definition. */
export type SchemaColumns = Record<string, ColumnDef>;

/** Infer the row type from a schema columns definition. */
export type InferRow<S extends SchemaColumns> = {
  [K in keyof S]: InferColumnType<S[K]>;
};

/** A table schema definition. */
export interface TableSchema<S extends SchemaColumns = SchemaColumns> {
  readonly name: string;
  readonly columns: S;
}

/** Create a table schema definition. */
export function defineTableSchema<S extends SchemaColumns>(
  name: string,
  columns: S,
): TableSchema<S> {
  return { name, columns };
}
