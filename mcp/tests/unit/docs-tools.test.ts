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
    apiKey: "pqdb_service_testkey123",
    encryptionKey: undefined,
    devToken: undefined,
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

// ── pqdb_search_docs ────────────────────────────────────────────────

describe("pqdb_search_docs tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_search_docs");
  });

  it("has a required query parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_search_docs");
    expect(tool?.inputSchema.required).toContain("query");
  });

  it("returns results for 'encryption' keyword", async () => {
    const result = await client.callTool({
      name: "pqdb_search_docs",
      arguments: { query: "encryption" },
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toBeDefined();
    expect(parsed.results.length).toBeGreaterThan(0);
    // Should find docs about encryption/PQC
    const allText = parsed.results.map((r: { title: string; content: string }) => r.content).join(" ").toLowerCase();
    expect(allText).toContain("encrypt");
  });

  it("returns results for 'column sensitivity' query", async () => {
    const result = await client.callTool({
      name: "pqdb_search_docs",
      arguments: { query: "column sensitivity" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.results.length).toBeGreaterThan(0);
    const allText = parsed.results.map((r: { title: string; content: string }) => r.content).join(" ").toLowerCase();
    expect(allText).toContain("sensitivity");
  });

  it("returns results for 'query operations' search", async () => {
    const result = await client.callTool({
      name: "pqdb_search_docs",
      arguments: { query: "query filter operations" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("returns empty results for nonsense query", async () => {
    const result = await client.callTool({
      name: "pqdb_search_docs",
      arguments: { query: "xyzzyplugh" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toEqual([]);
  });

  it("does not make any fetch calls (static content)", async () => {
    await client.callTool({
      name: "pqdb_search_docs",
      arguments: { query: "encryption" },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns results for 'api key' query", async () => {
    const result = await client.callTool({
      name: "pqdb_search_docs",
      arguments: { query: "api key authentication" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.results.length).toBeGreaterThan(0);
  });
});

// ── pqdb_generate_types ─────────────────────────────────────────────

describe("pqdb_generate_types tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_generate_types");
  });

  it("generates TypeScript interfaces from introspection", async () => {
    const introspectResponse = {
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "uuid", sensitivity: "plain", is_owner: false },
            { name: "email", type: "text", sensitivity: "searchable", is_owner: false },
            { name: "name", type: "text", sensitivity: "plain", is_owner: false },
            { name: "created_at", type: "timestamp", sensitivity: "plain", is_owner: false },
          ],
          sensitivity_summary: { plain: 3, searchable: 1 },
        },
        {
          name: "posts",
          columns: [
            { name: "id", type: "uuid", sensitivity: "plain", is_owner: false },
            { name: "title", type: "text", sensitivity: "plain", is_owner: false },
            { name: "body", type: "text", sensitivity: "private", is_owner: false },
            { name: "user_id", type: "uuid", sensitivity: "plain", is_owner: true },
          ],
          sensitivity_summary: { plain: 3, private: 1 },
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => introspectResponse,
    });

    const result = await client.callTool({
      name: "pqdb_generate_types",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { type: string; text: string }).text;

    // Should contain interface definitions
    expect(text).toContain("interface Users");
    expect(text).toContain("interface Posts");
    expect(text).toContain("id: string");
    expect(text).toContain("email: string");
    expect(text).toContain("title: string");
    expect(text).toContain("body: string");
    expect(text).toContain("user_id: string");
  });

  it("maps common SQL types to TypeScript types", async () => {
    const introspectResponse = {
      tables: [
        {
          name: "metrics",
          columns: [
            { name: "id", type: "integer", sensitivity: "plain", is_owner: false },
            { name: "value", type: "numeric", sensitivity: "plain", is_owner: false },
            { name: "active", type: "boolean", sensitivity: "plain", is_owner: false },
            { name: "data", type: "jsonb", sensitivity: "plain", is_owner: false },
            { name: "tags", type: "text[]", sensitivity: "plain", is_owner: false },
          ],
          sensitivity_summary: { plain: 5 },
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => introspectResponse,
    });

    const result = await client.callTool({
      name: "pqdb_generate_types",
      arguments: {},
    });

    const text = (result.content[0] as { type: string; text: string }).text;

    expect(text).toContain("id: number");
    expect(text).toContain("value: number");
    expect(text).toContain("active: boolean");
    expect(text).toContain("data: Record<string, unknown>");
    expect(text).toContain("tags: string[]");
  });

  it("adds sensitivity comment for non-plain columns", async () => {
    const introspectResponse = {
      tables: [
        {
          name: "accounts",
          columns: [
            { name: "id", type: "uuid", sensitivity: "plain", is_owner: false },
            { name: "ssn", type: "text", sensitivity: "private", is_owner: false },
            { name: "email", type: "text", sensitivity: "searchable", is_owner: false },
          ],
          sensitivity_summary: { plain: 1, private: 1, searchable: 1 },
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => introspectResponse,
    });

    const result = await client.callTool({
      name: "pqdb_generate_types",
      arguments: {},
    });

    const text = (result.content[0] as { type: string; text: string }).text;

    // Non-plain columns should have sensitivity annotations
    expect(text).toContain("private");
    expect(text).toContain("searchable");
  });

  it("returns error on API failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ detail: "Database unavailable" }),
    });

    const result = await client.callTool({
      name: "pqdb_generate_types",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("Database unavailable");
  });
});
