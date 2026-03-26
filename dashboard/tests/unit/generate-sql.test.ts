import { describe, it, expect } from "vitest";
import {
  generateCreateTableSQL,
  type ForeignKey,
} from "~/lib/generate-sql";
import type { IntrospectionTable } from "~/lib/schema";

const usersTable: IntrospectionTable = {
  name: "users",
  columns: [
    { name: "id", type: "uuid", sensitivity: "plain", is_owner: true, queryable: true },
    { name: "email", type: "text", sensitivity: "searchable", is_owner: false, queryable: true },
    { name: "name", type: "text", sensitivity: "plain", is_owner: false, queryable: true },
  ],
  sensitivity_summary: { plain: 2, searchable: 1, private: 0 },
};

const postsTable: IntrospectionTable = {
  name: "posts",
  columns: [
    { name: "id", type: "uuid", sensitivity: "plain", is_owner: false, queryable: true },
    { name: "author_id", type: "uuid", sensitivity: "plain", is_owner: false, queryable: true },
    { name: "title", type: "text", sensitivity: "plain", is_owner: false, queryable: true },
    { name: "body", type: "text", sensitivity: "private", is_owner: false, queryable: false },
  ],
  sensitivity_summary: { plain: 3, searchable: 0, private: 1 },
};

const fks: ForeignKey[] = [
  {
    constraint_name: "fk_posts_author",
    source_table: "posts",
    source_column: "author_id",
    target_table: "users",
    target_column: "id",
  },
];

describe("generateCreateTableSQL", () => {
  it("generates DDL for a single table with no FKs in logical mode", () => {
    const sql = generateCreateTableSQL([usersTable], [], "logical");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"id" uuid PRIMARY KEY');
    expect(sql).toContain('"email" text');
    expect(sql).toContain('"name" text');
    // Should NOT contain physical column names
    expect(sql).not.toContain("email_encrypted");
    expect(sql).not.toContain("email_index");
  });

  it("generates DDL with physical shadow columns in physical mode", () => {
    const sql = generateCreateTableSQL([usersTable], [], "physical");
    expect(sql).toContain('"email_encrypted" bytea');
    expect(sql).toContain('"email_index" text');
    // Should NOT contain logical "email" column
    expect(sql).not.toMatch(/"email" text/);
  });

  it("generates DDL with private columns as _encrypted in physical mode", () => {
    const sql = generateCreateTableSQL([postsTable], [], "physical");
    expect(sql).toContain('"body_encrypted" bytea');
    expect(sql).not.toMatch(/"body" text/);
  });

  it("includes FOREIGN KEY constraints", () => {
    const sql = generateCreateTableSQL([usersTable, postsTable], fks, "logical");
    expect(sql).toContain('CONSTRAINT "fk_posts_author"');
    expect(sql).toContain('FOREIGN KEY ("author_id") REFERENCES "users" ("id")');
  });

  it("generates multiple CREATE TABLE statements separated by blank lines", () => {
    const sql = generateCreateTableSQL([usersTable, postsTable], [], "logical");
    const statements = sql.split("\n\n");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE "users"');
    expect(statements[1]).toContain('CREATE TABLE "posts"');
  });

  it("returns empty string for empty tables array", () => {
    const sql = generateCreateTableSQL([], [], "logical");
    expect(sql).toBe("");
  });

  it("marks owner column as PRIMARY KEY", () => {
    const sql = generateCreateTableSQL([usersTable], [], "logical");
    expect(sql).toContain('"id" uuid PRIMARY KEY');
    // non-owner columns should not have PRIMARY KEY
    expect(sql).not.toContain('"name" text PRIMARY KEY');
  });
});
