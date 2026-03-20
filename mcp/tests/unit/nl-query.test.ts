import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import {
  translateNaturalLanguage,
  type SchemaInfo,
  type TranslationResult,
} from "../../src/nl-query.js";

// Mock @pqdb/client
vi.mock("@pqdb/client", () => ({
  createClient: vi.fn(() => ({
    auth: {},
    defineTable: vi.fn(),
    from: vi.fn(),
    reindex: vi.fn(),
  })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    projectUrl: "http://localhost:8000",
    transport: "stdio",
    port: 3001,
    apiKey: "pqdb_anon_testkey123",
    encryptionKey: undefined,
    ...overrides,
  };
}

async function createTestClient(
  config?: Partial<ServerConfig>,
): Promise<Client> {
  const { mcpServer } = createPqdbMcpServer(makeConfig(config));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function mockFetchOk(data: unknown): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

function mockFetchError(status: number, detail: string): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: `Error ${status}`,
    json: async () => ({ detail }),
  });
}

// ── translateNaturalLanguage unit tests ──────────────────────────────

const SAMPLE_SCHEMA: SchemaInfo[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "uuid", sensitivity: "plain", operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
      { name: "email", type: "text", sensitivity: "searchable", operations: ["eq", "in"] },
      { name: "name", type: "text", sensitivity: "plain", operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
      { name: "age", type: "integer", sensitivity: "plain", operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
      { name: "secret_notes", type: "text", sensitivity: "private", operations: [] },
    ],
  },
  {
    name: "posts",
    columns: [
      { name: "id", type: "uuid", sensitivity: "plain", operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
      { name: "title", type: "text", sensitivity: "plain", operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
      { name: "user_id", type: "uuid", sensitivity: "plain", operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
    ],
  },
];

describe("translateNaturalLanguage", () => {
  it("translates 'show all users'", () => {
    const result = translateNaturalLanguage("show all users", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("users");
    expect(result.columns).toEqual(["*"]);
    expect(result.filters).toEqual([]);
  });

  it("translates 'get posts'", () => {
    const result = translateNaturalLanguage("get posts", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("posts");
  });

  it("translates 'select name from users'", () => {
    const result = translateNaturalLanguage("select name from users", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("users");
    expect(result.columns).toContain("name");
  });

  it("translates 'show users where age > 25'", () => {
    const result = translateNaturalLanguage("show users where age > 25", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("users");
    expect(result.filters).toEqual([{ column: "age", op: "gt", value: "25" }]);
  });

  it("translates 'get users where name = Alice'", () => {
    const result = translateNaturalLanguage("get users where name = Alice", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("users");
    expect(result.filters).toEqual([{ column: "name", op: "eq", value: "Alice" }]);
  });

  it("translates 'list users where age >= 18'", () => {
    const result = translateNaturalLanguage("list users where age >= 18", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.filters).toEqual([{ column: "age", op: "gte", value: "18" }]);
  });

  it("translates 'show users where age <= 30'", () => {
    const result = translateNaturalLanguage("show users where age <= 30", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.filters).toEqual([{ column: "age", op: "lte", value: "30" }]);
  });

  it("translates 'get users where age < 21'", () => {
    const result = translateNaturalLanguage("get users where age < 21", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.filters).toEqual([{ column: "age", op: "lt", value: "21" }]);
  });

  it("translates with limit: 'show 10 users'", () => {
    const result = translateNaturalLanguage("show 10 users", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("users");
    expect(result.limit).toBe(10);
  });

  it("translates 'first 5 posts'", () => {
    const result = translateNaturalLanguage("first 5 posts", SAMPLE_SCHEMA);
    expect(result.success).toBe(true);
    expect(result.table).toBe("posts");
    expect(result.limit).toBe(5);
  });

  it("rejects .gt() on searchable columns", () => {
    const result = translateNaturalLanguage(
      "show users where email > test@example.com",
      SAMPLE_SCHEMA,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("searchable");
  });

  it("rejects .lt() on searchable columns", () => {
    const result = translateNaturalLanguage(
      "show users where email < test@example.com",
      SAMPLE_SCHEMA,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("searchable");
  });

  it("allows .eq() on searchable columns", () => {
    const result = translateNaturalLanguage(
      "show users where email = test@example.com",
      SAMPLE_SCHEMA,
    );
    expect(result.success).toBe(true);
    expect(result.filters).toEqual([{ column: "email", op: "eq", value: "test@example.com" }]);
  });

  it("rejects queries on private columns", () => {
    const result = translateNaturalLanguage(
      "show users where secret_notes = hello",
      SAMPLE_SCHEMA,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("private");
  });

  it("returns error for unknown table", () => {
    const result = translateNaturalLanguage("show orders", SAMPLE_SCHEMA);
    expect(result.success).toBe(false);
    expect(result.error).toContain("table");
  });

  it("returns error for unparseable query", () => {
    const result = translateNaturalLanguage("do something weird", SAMPLE_SCHEMA);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for unknown column in filter", () => {
    const result = translateNaturalLanguage(
      "show users where nonexistent = 5",
      SAMPLE_SCHEMA,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("column");
  });
});

// ── pqdb_natural_language_query MCP tool ─────────────────────────────

describe("pqdb_natural_language_query tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_natural_language_query");
  });

  it("has a required query parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_natural_language_query");
    expect(tool?.inputSchema.required).toContain("query");
  });

  it("fetches schema, translates NL query, and executes", async () => {
    // First call: introspect for schema
    mockFetchOk({
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "uuid", sensitivity: "plain", is_owner: false, queryable: true, operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
            { name: "name", type: "text", sensitivity: "plain", is_owner: false, queryable: true, operations: ["eq", "in", "gt", "gte", "lt", "lte"] },
          ],
          sensitivity_summary: { plain: 2 },
        },
      ],
    });
    // Second call: select query
    mockFetchOk({ data: [{ id: "1", name: "Alice" }] });

    const result = await client.callTool({
      name: "pqdb_natural_language_query",
      arguments: { query: "show all users" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual([{ id: "1", name: "Alice" }]);
    expect(parsed.error).toBeNull();
    expect(parsed.translated_query).toBeDefined();
  });

  it("returns error for untranslatable query", async () => {
    // Introspect call
    mockFetchOk({
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "uuid", sensitivity: "plain", is_owner: false, queryable: true, operations: ["eq"] },
          ],
          sensitivity_summary: { plain: 1 },
        },
      ],
    });

    const result = await client.callTool({
      name: "pqdb_natural_language_query",
      arguments: { query: "do something weird" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toBeDefined();
  });

  it("returns error when NL query violates sensitivity rules", async () => {
    // Introspect call
    mockFetchOk({
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "uuid", sensitivity: "plain", is_owner: false, queryable: true, operations: ["eq"] },
            { name: "email", type: "text", sensitivity: "searchable", is_owner: false, queryable: true, operations: ["eq", "in"] },
          ],
          sensitivity_summary: { plain: 1, searchable: 1 },
        },
      ],
    });

    const result = await client.callTool({
      name: "pqdb_natural_language_query",
      arguments: { query: "show users where email > test@example.com" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("searchable");
  });
});
