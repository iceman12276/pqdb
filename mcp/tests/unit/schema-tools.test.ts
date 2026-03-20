import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";

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

/** Helper: create a connected MCP client+server pair */
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

/** Sample introspection response for two tables */
const SAMPLE_INTROSPECT_ALL = {
  tables: [
    {
      name: "users",
      columns: [
        {
          name: "id",
          type: "uuid",
          sensitivity: "plain",
          is_owner: false,
          queryable: true,
          operations: ["eq", "neq", "in", "gt", "gte", "lt", "lte"],
        },
        {
          name: "email",
          type: "text",
          sensitivity: "searchable",
          is_owner: false,
          queryable: true,
          operations: ["eq", "in"],
        },
        {
          name: "secret_notes",
          type: "text",
          sensitivity: "private",
          is_owner: false,
          queryable: false,
          note: "retrieve only — no server-side filtering",
        },
      ],
      sensitivity_summary: { searchable: 1, private: 1, plain: 1 },
    },
    {
      name: "posts",
      columns: [
        {
          name: "id",
          type: "uuid",
          sensitivity: "plain",
          is_owner: false,
          queryable: true,
          operations: ["eq", "neq", "in", "gt", "gte", "lt", "lte"],
        },
        {
          name: "title",
          type: "text",
          sensitivity: "plain",
          is_owner: false,
          queryable: true,
          operations: ["eq", "neq", "in", "gt", "gte", "lt", "lte"],
        },
      ],
      sensitivity_summary: { searchable: 0, private: 0, plain: 2 },
    },
  ],
};

/** Single table introspection */
const SAMPLE_INTROSPECT_USERS = SAMPLE_INTROSPECT_ALL.tables[0];

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
    json: async () => ({ detail }),
  });
}

describe("pqdb_list_tables tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_tables");
  });

  it("returns table names with column counts and sensitivity summaries", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_ALL);

    const result = await client.callTool({
      name: "pqdb_list_tables",
      arguments: {},
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("users");
    expect(parsed[0].column_count).toBe(3);
    expect(parsed[0].sensitivity_summary).toEqual({
      searchable: 1,
      private: 1,
      plain: 1,
    });
    expect(parsed[1].name).toBe("posts");
    expect(parsed[1].column_count).toBe(2);
  });

  it("calls GET /v1/db/introspect with apikey header", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_ALL);

    await client.callTool({ name: "pqdb_list_tables", arguments: {} });

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:8000/v1/db/introspect", {
      method: "GET",
      headers: { apikey: "pqdb_anon_testkey123" },
    });
  });

  it("returns error when API call fails", async () => {
    mockFetchError(500, "Internal server error");

    const result = await client.callTool({
      name: "pqdb_list_tables",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("Internal server error");
  });
});

describe("pqdb_describe_table tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_describe_table");
  });

  it("has a required table_name parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_describe_table");
    expect(tool?.inputSchema.required).toContain("table_name");
  });

  it("returns full schema for a table", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_USERS);

    const result = await client.callTool({
      name: "pqdb_describe_table",
      arguments: { table_name: "users" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);

    expect(parsed.name).toBe("users");
    expect(parsed.columns).toHaveLength(3);
    expect(parsed.columns[0]).toEqual({
      name: "id",
      type: "uuid",
      sensitivity: "plain",
      is_owner: false,
      queryable: true,
      operations: ["eq", "neq", "in", "gt", "gte", "lt", "lte"],
    });
    expect(parsed.columns[1].sensitivity).toBe("searchable");
    expect(parsed.columns[1].operations).toEqual(["eq", "in"]);
    expect(parsed.columns[2].sensitivity).toBe("private");
    expect(parsed.columns[2].queryable).toBe(false);
  });

  it("calls GET /v1/db/introspect/{table_name} with apikey header", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_USERS);

    await client.callTool({
      name: "pqdb_describe_table",
      arguments: { table_name: "users" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/introspect/users",
      { method: "GET", headers: { apikey: "pqdb_anon_testkey123" } },
    );
  });

  it("returns error when table not found", async () => {
    mockFetchError(404, "Table 'nonexistent' not found");

    const result = await client.callTool({
      name: "pqdb_describe_table",
      arguments: { table_name: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("not found");
  });
});

describe("pqdb_describe_schema tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_describe_schema");
  });

  it("returns ERD-style overview of all tables", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_ALL);

    const result = await client.callTool({
      name: "pqdb_describe_schema",
      arguments: {},
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);

    expect(parsed.tables).toHaveLength(2);
    expect(parsed.tables[0].name).toBe("users");
    expect(parsed.tables[0].columns).toBeDefined();
    expect(parsed.tables[1].name).toBe("posts");
    // ERD includes foreign_keys (empty for now — pqdb doesn't track FK metadata)
    expect(parsed.tables[0].foreign_keys).toEqual([]);
  });

  it("calls GET /v1/db/introspect with apikey header", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_ALL);

    await client.callTool({ name: "pqdb_describe_schema", arguments: {} });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/introspect",
      { method: "GET", headers: { apikey: "pqdb_anon_testkey123" } },
    );
  });
});

describe("pqdb://tables resource", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is listed in resources", async () => {
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain("pqdb://tables");
  });

  it("returns list of table names", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_ALL);

    const result = await client.readResource({ uri: "pqdb://tables" });

    const text = (result.contents[0] as { uri: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(["users", "posts"]);
  });
});

describe("pqdb://tables/{name} resource template", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is listed in resource templates", async () => {
    const templates = await client.listResourceTemplates();
    const uriTemplates = templates.resourceTemplates.map((r) => r.uriTemplate);
    expect(uriTemplates).toContain("pqdb://tables/{name}");
  });

  it("returns column schema for a specific table", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_USERS);

    const result = await client.readResource({
      uri: "pqdb://tables/users",
    });

    const text = (result.contents[0] as { uri: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("users");
    expect(parsed.columns).toHaveLength(3);
  });
});

describe("pqdb://tables/{name}/stats resource template", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is listed in resource templates", async () => {
    const templates = await client.listResourceTemplates();
    const uriTemplates = templates.resourceTemplates.map((r) => r.uriTemplate);
    expect(uriTemplates).toContain("pqdb://tables/{name}/stats");
  });

  it("returns row count and sensitivity summary", async () => {
    // First call: introspect for sensitivity summary
    mockFetchOk(SAMPLE_INTROSPECT_USERS);
    // Second call: select to count rows
    mockFetchOk({ data: [{}, {}, {}] }); // 3 rows

    const result = await client.readResource({
      uri: "pqdb://tables/users/stats",
    });

    const text = (result.contents[0] as { uri: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.table).toBe("users");
    expect(parsed.row_count).toBe(3);
    expect(parsed.sensitivity_summary).toEqual({
      searchable: 1,
      private: 1,
      plain: 1,
    });
  });

  it("returns 0 row count when select returns empty", async () => {
    mockFetchOk(SAMPLE_INTROSPECT_USERS);
    mockFetchOk({ data: [] });

    const result = await client.readResource({
      uri: "pqdb://tables/users/stats",
    });

    const text = (result.contents[0] as { uri: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.row_count).toBe(0);
  });
});
