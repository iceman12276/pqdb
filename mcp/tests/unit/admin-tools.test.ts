import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import { setAuthState } from "../../src/auth-state.js";

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

// ── pqdb_execute_sql ────────────────────────────────────────────────

describe("pqdb_execute_sql tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_execute_sql");
  });

  it("has required query parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_execute_sql");
    expect(tool?.inputSchema.required).toContain("query");
  });

  it("calls POST /v1/db/sql with apikey header and body", async () => {
    const sqlResult = {
      columns: ["id", "name"],
      rows: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    };
    mockFetchOk(sqlResult);

    const result = await client.callTool({
      name: "pqdb_execute_sql",
      arguments: { query: "SELECT id, name FROM users", mode: "read" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/sql",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_service_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "SELECT id, name FROM users", mode: "read" }),
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(sqlResult);
    expect(parsed.error).toBeNull();
  });

  it("defaults mode to read when not specified", async () => {
    const sqlResult = { columns: ["count"], rows: [{ count: 42 }] };
    mockFetchOk(sqlResult);

    await client.callTool({
      name: "pqdb_execute_sql",
      arguments: { query: "SELECT count(*) FROM users" },
    });

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.mode).toBe("read");
  });

  it("returns error on API failure", async () => {
    mockFetchError(400, "Syntax error in SQL");

    const result = await client.callTool({
      name: "pqdb_execute_sql",
      arguments: { query: "INVALID SQL" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("Syntax error");
  });
});

// ── pqdb_list_extensions ────────────────────────────────────────────

describe("pqdb_list_extensions tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_extensions");
  });

  it("calls GET /v1/db/extensions with apikey header", async () => {
    const extensions = [
      { name: "pgcrypto", version: "1.3", comment: "cryptographic functions" },
      { name: "vector", version: "0.7.0", comment: "vector similarity search" },
    ];
    mockFetchOk(extensions);

    const result = await client.callTool({
      name: "pqdb_list_extensions",
      arguments: {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/extensions",
      {
        method: "GET",
        headers: { apikey: "pqdb_service_testkey123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(extensions);
    expect(parsed.error).toBeNull();
  });

  it("returns error on API failure", async () => {
    mockFetchError(500, "Database connection failed");

    const result = await client.callTool({
      name: "pqdb_list_extensions",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("connection failed");
  });
});

// ── pqdb_list_migrations ────────────────────────────────────────────

describe("pqdb_list_migrations tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
    // pqdb_list_migrations hits the backend via `apikeyGet` with an
    // empty apiKey string, which then reads the developer JWT and
    // project ID from auth-state to build headers. Tests have to
    // populate auth-state explicitly — `createPqdbMcpServer` does
    // not (in production, `http-app.ts` sets auth-state on the
    // initialize request).
    setAuthState({
      devToken: "dev-jwt-token-123",
      projectId: "proj-test-123",
      projectUrl: "http://localhost:8000",
    });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_migrations");
  });

  it("calls GET /v1/projects/migrations with Bearer + x-project-id headers", async () => {
    const migrations = [
      { revision: "abc123", description: "create users table", applied_at: "2026-01-01" },
      { revision: "def456", description: "add posts table", applied_at: "2026-01-02" },
    ];
    mockFetchOk(migrations);

    const result = await client.callTool({
      name: "pqdb_list_migrations",
      arguments: {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/migrations",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer dev-jwt-token-123",
          "x-project-id": "proj-test-123",
        },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(migrations);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.resetAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_list_migrations",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });

  it("returns error on API failure", async () => {
    mockFetchError(401, "Invalid token");

    const result = await client.callTool({
      name: "pqdb_list_migrations",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("Invalid token");
  });
});
