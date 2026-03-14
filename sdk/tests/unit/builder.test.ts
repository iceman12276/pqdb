import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { column, defineTableSchema } from "../../src/query/schema.js";
import { QueryBuilder } from "../../src/query/builder.js";
import { HttpClient } from "../../src/client/http.js";

const usersSchema = defineTableSchema("users", {
  id: column.uuid().primaryKey(),
  email: column.text().sensitive("searchable"),
  name: column.text().sensitive("private"),
  age: column.integer(),
  active: column.boolean(),
});

function createMockHttp(): HttpClient {
  return new HttpClient("http://localhost:3000", "pqdb_anon_test123");
}

describe("QueryBuilder.select", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let http: HttpClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", email: "a@b.com", name: "Alice", age: 30, active: true }],
    });
    vi.stubGlobal("fetch", fetchMock);
    http = createMockHttp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a SELECT payload with no columns (select all)", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    const { data, error } = await builder.select().execute();

    expect(error).toBeNull();
    expect(data).toEqual([{ id: "1", email: "a@b.com", name: "Alice", age: 30, active: true }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/users/select");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.columns).toBe("*");
    expect(body.filters).toEqual([]);
    expect(body.modifiers).toEqual({});
  });

  it("builds a SELECT payload with specific columns", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select("id", "email").execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.columns).toEqual(["id", "email"]);
  });

  it("chains .eq() filter", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().eq("age", 25).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "eq", value: 25 }]);
  });

  it("chains .gt() filter", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().gt("age", 18).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "gt", value: 18 }]);
  });

  it("chains .lt() filter", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().lt("age", 65).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "lt", value: 65 }]);
  });

  it("chains .gte() filter", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().gte("age", 21).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "gte", value: 21 }]);
  });

  it("chains .lte() filter", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().lte("age", 100).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "lte", value: 100 }]);
  });

  it("chains .in() filter", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().in("age", [25, 30, 35]).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "age", op: "in", value: [25, 30, 35] }]);
  });

  it("chains multiple filters", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().gte("age", 18).lte("age", 65).eq("active", true).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([
      { column: "age", op: "gte", value: 18 },
      { column: "age", op: "lte", value: 65 },
      { column: "active", op: "eq", value: true },
    ]);
  });

  it("chains .limit() modifier", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().limit(10).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.modifiers.limit).toBe(10);
  });

  it("chains .offset() modifier", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().offset(20).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.modifiers.offset).toBe(20);
  });

  it("chains .order() modifier", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().order("age", "desc").execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.modifiers.order).toEqual({ column: "age", direction: "desc" });
  });

  it("chains filters and modifiers together", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.select().eq("active", true).order("age", "asc").limit(5).offset(0).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "active", op: "eq", value: true }]);
    expect(body.modifiers).toEqual({
      order: { column: "age", direction: "asc" },
      limit: 5,
      offset: 0,
    });
  });
});

describe("QueryBuilder.insert", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let http: HttpClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", email: "a@b.com", name: "Alice", age: 30, active: true }],
    });
    vi.stubGlobal("fetch", fetchMock);
    http = createMockHttp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an INSERT payload with a single row", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder
      .insert([{ id: "1", email: "a@b.com", name: "Alice", age: 30, active: true }])
      .execute();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/users/insert");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.rows).toEqual([
      { id: "1", email: "a@b.com", name: "Alice", age: 30, active: true },
    ]);
  });

  it("builds an INSERT payload with multiple rows", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder
      .insert([
        { id: "1", email: "a@b.com", name: "Alice", age: 30, active: true },
        { id: "2", email: "b@b.com", name: "Bob", age: 25, active: false },
      ])
      .execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.rows).toHaveLength(2);
  });
});

describe("QueryBuilder.update", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let http: HttpClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", email: "a@b.com", name: "Alice", age: 31, active: true }],
    });
    vi.stubGlobal("fetch", fetchMock);
    http = createMockHttp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an UPDATE payload with values and filters", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.update({ age: 31 }).eq("id", "1").execute();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/users/update");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.values).toEqual({ age: 31 });
    expect(body.filters).toEqual([{ column: "id", op: "eq", value: "1" }]);
  });

  it("builds an UPDATE payload with no filters", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.update({ active: false }).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.values).toEqual({ active: false });
    expect(body.filters).toEqual([]);
  });
});

describe("QueryBuilder.delete", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let http: HttpClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", email: "a@b.com", name: "Alice", age: 30, active: true }],
    });
    vi.stubGlobal("fetch", fetchMock);
    http = createMockHttp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a DELETE payload with filters", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.delete().eq("id", "1").execute();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/users/delete");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([{ column: "id", op: "eq", value: "1" }]);
  });

  it("builds a DELETE payload with no filters (delete all)", async () => {
    const builder = new QueryBuilder(http, usersSchema);
    await builder.delete().execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([]);
  });
});

describe("QueryBuilder error handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let http: HttpClient;

  beforeEach(() => {
    http = createMockHttp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { data: null, error } on HTTP error", async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ detail: "Invalid query" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const builder = new QueryBuilder(http, usersSchema);
    const { data, error } = await builder.select().execute();

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("HTTP_400");
    expect(error!.message).toBe("Invalid query");
  });

  it("returns { data: null, error } on network error", async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const builder = new QueryBuilder(http, usersSchema);
    const { data, error } = await builder.select().execute();

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("NETWORK_ERROR");
  });
});
