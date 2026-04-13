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

// ── pqdb_list_users ──────────────────────────────────────────────────

describe("pqdb_list_users tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_users");
  });

  it("POSTs a read-only SQL query against _pqdb_users using the apikey", async () => {
    // The handler was refactored away from a dedicated /v1/auth/users
    // endpoint to a SQL query against the `_pqdb_users` table (there
    // is no dedicated list-users REST endpoint). The proper assertion
    // is that the handler sends a read-only SQL SELECT and forwards
    // the `rows` payload.
    const sqlResponse = {
      rows: [
        { id: "u1", email: "alice@test.com", role: "authenticated", email_verified: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "u2", email: "bob@test.com", role: "admin", email_verified: false, created_at: "2026-01-02T00:00:00Z" },
      ],
      columns: ["id", "email", "role", "email_verified", "created_at"],
      row_count: 2,
    };
    mockFetchOk(sqlResponse);

    const result = await client.callTool({
      name: "pqdb_list_users",
      arguments: {},
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("http://localhost:8000/v1/db/sql");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ apikey: "pqdb_service_testkey123" });
    const body = JSON.parse(options.body) as { query: string; mode: string };
    expect(body.mode).toBe("read");
    expect(body.query).toMatch(/SELECT .* FROM _pqdb_users/);

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(sqlResponse.rows);
    expect(parsed.error).toBeNull();
  });

  it("returns error on API failure", async () => {
    mockFetchError(403, "Only service_role API keys can list users");

    const result = await client.callTool({
      name: "pqdb_list_users",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("service_role");
  });
});

// ── pqdb_list_roles ──────────────────────────────────────────────────

describe("pqdb_list_roles tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = await createTestClient();
    // pqdb_list_roles hits the project-scoped endpoint
    // /v1/projects/{project_id}/auth/roles and reads both the
    // developer JWT and the project ID from auth-state. The test
    // helper has to populate auth-state explicitly — in production,
    // http-app.ts sets it on the initialize request.
    setAuthState({
      devToken: "dev-jwt-token-123",
      projectId: "proj-test-123",
      projectUrl: "http://localhost:8000",
    });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_roles");
  });

  it("calls GET /v1/projects/{pid}/auth/roles with Bearer header", async () => {
    const roles = [
      { id: "r1", name: "anon", description: "Anonymous" },
      { id: "r2", name: "authenticated", description: "Authenticated user" },
      { id: "r3", name: "admin", description: "Admin role" },
    ];
    mockFetchOk(roles);

    const result = await client.callTool({
      name: "pqdb_list_roles",
      arguments: {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-test-123/auth/roles",
      { headers: { Authorization: "Bearer dev-jwt-token-123" } },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(roles);
    expect(parsed.error).toBeNull();
  });

  it("returns error on API failure", async () => {
    mockFetchError(500, "Internal server error");

    const result = await client.callTool({
      name: "pqdb_list_roles",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("Internal server error");
  });
});

// ── pqdb_list_policies ───────────────────────────────────────────────

describe("pqdb_list_policies tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_policies");
  });

  it("has a required table_name parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_list_policies");
    expect(tool?.inputSchema.required).toContain("table_name");
  });

  it("calls GET /v1/db/tables/{name}/policies with apikey header", async () => {
    const policies = [
      {
        id: "p1",
        name: "allow_owner_select",
        table_name: "posts",
        operation: "select",
        role: "authenticated",
        condition: "owner",
      },
    ];
    mockFetchOk(policies);

    const result = await client.callTool({
      name: "pqdb_list_policies",
      arguments: { table_name: "posts" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/tables/posts/policies",
      {
        method: "GET",
        headers: { apikey: "pqdb_service_testkey123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(policies);
    expect(parsed.error).toBeNull();
  });

  it("returns error when table not found", async () => {
    mockFetchError(404, "Table 'nonexistent' not found");

    const result = await client.callTool({
      name: "pqdb_list_policies",
      arguments: { table_name: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("not found");
  });
});
