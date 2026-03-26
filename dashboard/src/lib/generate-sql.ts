/**
 * Generate CREATE TABLE DDL from introspection data.
 * Used by the "Copy as SQL" feature in the ERD view.
 */

import type { IntrospectionTable, IntrospectionColumn } from "./schema";

export interface ForeignKey {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

/**
 * Map logical column types to Postgres DDL types.
 * For physical columns (encrypted/index), use their actual storage types.
 */
function columnDDL(col: IntrospectionColumn, viewMode: "logical" | "physical"): string[] {
  if (viewMode === "physical") {
    if (col.sensitivity === "searchable") {
      return [
        `  "${col.name}_encrypted" bytea`,
        `  "${col.name}_index" text`,
      ];
    }
    if (col.sensitivity === "private") {
      return [`  "${col.name}_encrypted" bytea`];
    }
  }
  const constraint = col.is_owner ? " PRIMARY KEY" : "";
  return [`  "${col.name}" ${col.type}${constraint}`];
}

/**
 * Generate CREATE TABLE statements for all tables.
 * Includes column types, PRIMARY KEY constraints, and FOREIGN KEY constraints.
 */
export function generateCreateTableSQL(
  tables: IntrospectionTable[],
  foreignKeys: ForeignKey[],
  viewMode: "logical" | "physical",
): string {
  const statements: string[] = [];

  for (const table of tables) {
    const lines: string[] = [];

    for (const col of table.columns) {
      lines.push(...columnDDL(col, viewMode));
    }

    // Add FK constraints for this table
    const tableFKs = foreignKeys.filter(
      (fk) => fk.source_table === table.name,
    );
    for (const fk of tableFKs) {
      lines.push(
        `  CONSTRAINT "${fk.constraint_name}" FOREIGN KEY ("${fk.source_column}") REFERENCES "${fk.target_table}" ("${fk.target_column}")`,
      );
    }

    const body = lines.join(",\n");
    statements.push(`CREATE TABLE "${table.name}" (\n${body}\n);`);
  }

  return statements.join("\n\n");
}
