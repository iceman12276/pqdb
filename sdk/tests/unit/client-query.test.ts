import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";
import { column } from "../../src/query/schema.js";

describe("client.defineTable", () => {
  it("registers a table and returns a TableSchema", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_test123");
    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      age: column.integer(),
    });

    expect(users.name).toBe("users");
    expect(users.columns.id.type).toBe("uuid");
    expect(users.columns.email.sensitivity).toBe("searchable");
    expect(users.columns.age.type).toBe("integer");
  });
});

describe("client.from", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", email: "a@b.com", age: 30 }],
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a QueryBuilder for the given table schema", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_test123");
    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      age: column.integer(),
    });

    const { data, error } = await client.from(users).select().execute();

    expect(error).toBeNull();
    expect(data).toEqual([{ id: "1", email: "a@b.com", age: 30 }]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/users/select");
  });

  it("sends the apikey header on query requests", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_mykey");
    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      age: column.integer(),
    });

    await client.from(users).select().execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["apikey"]).toBe("pqdb_anon_mykey");
  });

  it("allows chaining filters through from()", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_test123");
    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      age: column.integer(),
    });

    await client.from(users).select().eq("age", 25).limit(10).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "eq", value: 25 }]);
    expect(body.modifiers.limit).toBe(10);
  });
});
