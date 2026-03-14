import { describe, it, expect } from "vitest";
import { column, defineTableSchema } from "../../src/query/schema.js";

describe("column helpers", () => {
  it("column.uuid() creates a uuid column definition", () => {
    const col = column.uuid();
    expect(col.type).toBe("uuid");
    expect(col.sensitivity).toBe("plain");
    expect(col.isPrimaryKey).toBe(false);
  });

  it("column.text() creates a text column definition", () => {
    const col = column.text();
    expect(col.type).toBe("text");
    expect(col.sensitivity).toBe("plain");
  });

  it("column.integer() creates an integer column definition", () => {
    const col = column.integer();
    expect(col.type).toBe("integer");
    expect(col.sensitivity).toBe("plain");
  });

  it("column.timestamp() creates a timestamp column definition", () => {
    const col = column.timestamp();
    expect(col.type).toBe("timestamp");
    expect(col.sensitivity).toBe("plain");
  });

  it("column.boolean() creates a boolean column definition", () => {
    const col = column.boolean();
    expect(col.type).toBe("boolean");
    expect(col.sensitivity).toBe("plain");
  });

  it("column.vector(dimensions) creates a vector column definition", () => {
    const col = column.vector(768);
    expect(col.type).toBe("vector");
    expect(col.dimensions).toBe(768);
    expect(col.sensitivity).toBe("plain");
  });
});

describe("sensitivity decorator", () => {
  it(".sensitive('searchable') sets sensitivity to searchable", () => {
    const col = column.text().sensitive("searchable");
    expect(col.sensitivity).toBe("searchable");
  });

  it(".sensitive('private') sets sensitivity to private", () => {
    const col = column.text().sensitive("private");
    expect(col.sensitivity).toBe("private");
  });

  it("chaining sensitive returns a new ColumnDef (immutable)", () => {
    const base = column.text();
    const sensitive = base.sensitive("searchable");
    expect(base.sensitivity).toBe("plain");
    expect(sensitive.sensitivity).toBe("searchable");
  });
});

describe("primaryKey chain", () => {
  it(".primaryKey() marks column as primary key", () => {
    const col = column.uuid().primaryKey();
    expect(col.isPrimaryKey).toBe(true);
  });

  it("primaryKey returns a new ColumnDef (immutable)", () => {
    const base = column.uuid();
    const pk = base.primaryKey();
    expect(base.isPrimaryKey).toBe(false);
    expect(pk.isPrimaryKey).toBe(true);
  });

  it("chaining primaryKey and sensitive together works", () => {
    const col = column.text().sensitive("searchable").primaryKey();
    expect(col.sensitivity).toBe("searchable");
    expect(col.isPrimaryKey).toBe(true);
  });
});

describe("defineTableSchema", () => {
  it("creates a table schema with name and columns", () => {
    const schema = defineTableSchema("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      name: column.text().sensitive("private"),
      age: column.integer(),
    });

    expect(schema.name).toBe("users");
    expect(schema.columns.id.type).toBe("uuid");
    expect(schema.columns.id.isPrimaryKey).toBe(true);
    expect(schema.columns.email.sensitivity).toBe("searchable");
    expect(schema.columns.name.sensitivity).toBe("private");
    expect(schema.columns.age.type).toBe("integer");
    expect(schema.columns.age.sensitivity).toBe("plain");
  });
});
