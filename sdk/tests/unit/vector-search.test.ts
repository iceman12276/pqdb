import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { column, defineTableSchema } from "../../src/query/schema.js";
import { QueryBuilder } from "../../src/query/builder.js";
import { HttpClient } from "../../src/client/http.js";

// Schema with a plain vector column for testing
const documentsSchema = defineTableSchema("documents", {
  id: column.uuid().primaryKey(),
  title: column.text(),
  embedding: column.vector(1536),
});

function createMockHttp(): HttpClient {
  return new HttpClient("http://localhost:3000", "pqdb_anon_test123");
}

describe("QueryBuilder.select().similarTo()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let http: HttpClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: "1", title: "Doc 1", embedding: [0.1, 0.2, 0.3] },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    http = createMockHttp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds similar_to field to the select payload", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    const vec = [0.1, 0.2, 0.3];
    await builder.select().similarTo("embedding", vec, { limit: 5 }).execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.similar_to).toEqual({
      column: "embedding",
      vector: vec,
      limit: 5,
      distance: "cosine",
    });
  });

  it("defaults distance to cosine", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    await builder
      .select()
      .similarTo("embedding", [1, 2, 3], { limit: 10 })
      .execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.similar_to.distance).toBe("cosine");
  });

  it("accepts l2 distance", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    await builder
      .select()
      .similarTo("embedding", [1, 2, 3], { limit: 5, distance: "l2" })
      .execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.similar_to.distance).toBe("l2");
  });

  it("accepts inner_product distance", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    await builder
      .select()
      .similarTo("embedding", [1, 2, 3], {
        limit: 5,
        distance: "inner_product",
      })
      .execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.similar_to.distance).toBe("inner_product");
  });

  it("can combine .similarTo() with .eq() filter", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    await builder
      .select()
      .eq("title", "hello")
      .similarTo("embedding", [1, 2, 3], { limit: 5 })
      .execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filters).toEqual([
      { column: "title", op: "eq", value: "hello" },
    ]);
    expect(body.similar_to).toEqual({
      column: "embedding",
      vector: [1, 2, 3],
      limit: 5,
      distance: "cosine",
    });
  });

  it("can combine .similarTo() with .limit() modifier", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    await builder
      .select()
      .similarTo("embedding", [1, 2, 3], { limit: 5 })
      .limit(100)
      .execute();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.similar_to.limit).toBe(5);
    expect(body.modifiers.limit).toBe(100);
  });

  it("returns { data, error } pattern — never throws", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    const { data, error } = await builder
      .select()
      .similarTo("embedding", [1, 2, 3], { limit: 5 })
      .execute();

    expect(error).toBeNull();
    expect(data).toEqual([
      { id: "1", title: "Doc 1", embedding: [0.1, 0.2, 0.3] },
    ]);
  });

  it("throws error when .similarTo() is combined with .order()", () => {
    const builder = new QueryBuilder(http, documentsSchema);
    expect(() =>
      builder
        .select()
        .similarTo("embedding", [1, 2, 3], { limit: 5 })
        .order("title", "asc"),
    ).toThrow("Cannot combine .similarTo() with .order()");
  });

  it("throws error when .order() is set before .similarTo()", () => {
    const builder = new QueryBuilder(http, documentsSchema);
    expect(() =>
      builder
        .select()
        .order("title", "asc")
        .similarTo("embedding", [1, 2, 3], { limit: 5 }),
    ).toThrow("Cannot combine .similarTo() with .order()");
  });

  it("includes similar_to alongside columns and modifiers in payload", async () => {
    const builder = new QueryBuilder(http, documentsSchema);
    await builder
      .select("id", "title")
      .similarTo("embedding", [0.5, 0.6], { limit: 3, distance: "l2" })
      .offset(10)
      .execute();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/documents/select");
    const body = JSON.parse(init.body as string);
    expect(body.columns).toEqual(["id", "title"]);
    expect(body.similar_to).toEqual({
      column: "embedding",
      vector: [0.5, 0.6],
      limit: 3,
      distance: "l2",
    });
    expect(body.modifiers.offset).toBe(10);
  });
});
