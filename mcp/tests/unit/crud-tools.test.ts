import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ── pqdb_query_rows ─────────────────────────────────────────────────

describe("pqdb_query_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_query_rows");
  });

  it("has a required table parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_query_rows");
    expect(tool?.inputSchema.required).toContain("table");
  });

  it("calls POST /v1/db/{table}/select with correct body", async () => {
    mockFetchOk({ data: [{ id: "1", name: "Alice" }] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: {
        table: "users",
        columns: ["id", "name"],
        filters: [{ column: "id", op: "eq", value: "1" }],
        limit: 10,
        offset: 0,
        order_by: "name",
        order_dir: "asc",
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/select",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_anon_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          columns: ["id", "name"],
          filters: [{ column: "id", op: "eq", value: "1" }],
          modifiers: { limit: 10, offset: 0, order_by: "name", order_dir: "asc" },
        }),
      },
    );
  });

  it("returns { data, error: null } on success", async () => {
    const rows = [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }];
    mockFetchOk({ data: rows });

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(rows);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(404, "Table 'missing' not found");

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "missing" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("not found");
  });

  it("defaults to all columns when columns not provided", async () => {
    mockFetchOk({ data: [] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users" },
    });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as unknown[])[1] &&
        ((mockFetch.mock.calls[0] as unknown[])[1] as { body: string }).body,
    );
    expect(body.columns).toEqual(["*"]);
  });

  it("replaces encrypted values with [encrypted] when no encryption key", async () => {
    mockFetchOk({
      data: [
        {
          id: "1",
          email_encrypted: "base64ciphertext==",
          email_index: "hmac_hash",
          name: "Alice",
        },
      ],
    });

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data[0].email_encrypted).toBe("[encrypted]");
    expect(parsed.data[0].name).toBe("Alice");
  });
});

// ── pqdb_insert_rows ────────────────────────────────────────────────

describe("pqdb_insert_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_insert_rows");
  });

  it("has required table and rows parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_insert_rows");
    expect(tool?.inputSchema.required).toContain("table");
    expect(tool?.inputSchema.required).toContain("rows");
  });

  it("calls POST /v1/db/{table}/insert with correct body", async () => {
    const rows = [{ name: "Alice" }, { name: "Bob" }];
    mockFetchOk({ data: rows });

    await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/insert",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_anon_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rows }),
      },
    );
  });

  it("returns { data, error: null } on success", async () => {
    const inserted = [{ id: "1", name: "Alice" }];
    mockFetchOk({ data: inserted });

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows: [{ name: "Alice" }] },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(inserted);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(400, "Must provide at least one row");

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows: [] },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("at least one row");
  });

  it("errors when rows contain _encrypted columns without encryption key", async () => {
    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: {
        table: "users",
        rows: [{ email_encrypted: "some_value", name: "Alice" }],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("encryption");
  });
});

// ── pqdb_update_rows ────────────────────────────────────────────────

describe("pqdb_update_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_update_rows");
  });

  it("has required table and values parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_update_rows");
    expect(tool?.inputSchema.required).toContain("table");
    expect(tool?.inputSchema.required).toContain("values");
  });

  it("calls POST /v1/db/{table}/update with correct body", async () => {
    mockFetchOk({ data: [{ id: "1", name: "Bob" }] });

    await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { name: "Bob" },
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/update",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_anon_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: { name: "Bob" },
          filters: [{ column: "id", op: "eq", value: "1" }],
        }),
      },
    );
  });

  it("returns { data, error: null } on success", async () => {
    const updated = [{ id: "1", name: "Bob" }];
    mockFetchOk({ data: updated });

    const result = await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { name: "Bob" },
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(updated);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(400, "Must provide values to update");

    const result = await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: {},
        filters: [],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("values to update");
  });

  it("errors when values contain _encrypted columns without encryption key", async () => {
    const result = await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { email_encrypted: "some_value" },
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("encryption");
  });
});

// ── pqdb_delete_rows ────────────────────────────────────────────────

describe("pqdb_delete_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_delete_rows");
  });

  it("has required table and filters parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_delete_rows");
    expect(tool?.inputSchema.required).toContain("table");
    expect(tool?.inputSchema.required).toContain("filters");
  });

  it("calls POST /v1/db/{table}/delete with correct body", async () => {
    mockFetchOk({ data: [{ id: "1" }] });

    await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/delete",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_anon_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: [{ column: "id", op: "eq", value: "1" }],
        }),
      },
    );
  });

  it("returns { data, error: null } on success", async () => {
    const deleted = [{ id: "1", name: "Alice" }];
    mockFetchOk({ data: deleted });

    const result = await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(deleted);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(400, "At least one filter is required");

    const result = await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("filter");
  });
});
