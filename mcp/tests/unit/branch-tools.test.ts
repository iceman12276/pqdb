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

// ── pqdb_create_branch ────────────────────────────────────────────────

describe("pqdb_create_branch tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_create_branch");
  });

  it("has required project_id and name parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_create_branch");
    expect(tool?.inputSchema.required).toContain("project_id");
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("calls POST /v1/projects/{id}/branches with Authorization header", async () => {
    const branch = { name: "feature-x", created_at: "2026-03-27T00:00:00Z" };
    mockFetchOk(branch);

    const result = await client.callTool({
      name: "pqdb_create_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/branches",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-jwt-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "feature-x" }),
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(branch);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_create_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });

  it("returns error on API failure", async () => {
    mockFetchError(409, "Branch already exists");

    const result = await client.callTool({
      name: "pqdb_create_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("already exists");
  });
});

// ── pqdb_list_branches ──────────────────────────────────────────────

describe("pqdb_list_branches tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_branches");
  });

  it("has required project_id parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_list_branches");
    expect(tool?.inputSchema.required).toContain("project_id");
  });

  it("calls GET /v1/projects/{id}/branches with Authorization header", async () => {
    const branches = [
      { name: "main", created_at: "2026-03-01T00:00:00Z" },
      { name: "feature-x", created_at: "2026-03-27T00:00:00Z" },
    ];
    mockFetchOk(branches);

    const result = await client.callTool({
      name: "pqdb_list_branches",
      arguments: { project_id: "proj-123" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/branches",
      {
        method: "GET",
        headers: { Authorization: "Bearer dev-jwt-token-123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(branches);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_list_branches",
      arguments: { project_id: "proj-123" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });
});

// ── pqdb_delete_branch ──────────────────────────────────────────────

describe("pqdb_delete_branch tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_delete_branch");
  });

  it("has required project_id and name parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_delete_branch");
    expect(tool?.inputSchema.required).toContain("project_id");
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("calls DELETE /v1/projects/{id}/branches/{name} with Authorization header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
    });

    const result = await client.callTool({
      name: "pqdb_delete_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/branches/feature-x",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer dev-jwt-token-123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_delete_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });

  it("returns error on API failure", async () => {
    mockFetchError(404, "Branch not found");

    const result = await client.callTool({
      name: "pqdb_delete_branch",
      arguments: { project_id: "proj-123", name: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("not found");
  });
});

// ── pqdb_merge_branch ───────────────────────────────────────────────

describe("pqdb_merge_branch tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_merge_branch");
  });

  it("has required project_id and name parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_merge_branch");
    expect(tool?.inputSchema.required).toContain("project_id");
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("calls POST /v1/projects/{id}/branches/{name}/promote with Authorization header", async () => {
    const response = { status: "merged", branch: "feature-x" };
    mockFetchOk(response);

    const result = await client.callTool({
      name: "pqdb_merge_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/branches/feature-x/promote",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-jwt-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(response);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_merge_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });

  it("returns error on API failure", async () => {
    mockFetchError(409, "Merge conflict");

    const result = await client.callTool({
      name: "pqdb_merge_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("conflict");
  });
});

// ── pqdb_rebase_branch ──────────────────────────────────────────────

describe("pqdb_rebase_branch tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_rebase_branch");
  });

  it("has required project_id and name parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_rebase_branch");
    expect(tool?.inputSchema.required).toContain("project_id");
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("calls POST /v1/projects/{id}/branches/{name}/rebase with Authorization header", async () => {
    const response = { status: "rebased", branch: "feature-x" };
    mockFetchOk(response);

    const result = await client.callTool({
      name: "pqdb_rebase_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/branches/feature-x/rebase",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-jwt-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(response);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_rebase_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });
});

// ── pqdb_reset_branch ───────────────────────────────────────────────

describe("pqdb_reset_branch tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_reset_branch");
  });

  it("has required project_id and name parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_reset_branch");
    expect(tool?.inputSchema.required).toContain("project_id");
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("calls POST /v1/projects/{id}/branches/{name}/reset with Authorization header", async () => {
    const response = { status: "reset", branch: "feature-x" };
    mockFetchOk(response);

    const result = await client.callTool({
      name: "pqdb_reset_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/branches/feature-x/reset",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-jwt-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(response);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_reset_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });

  it("returns error on API failure", async () => {
    mockFetchError(404, "Branch not found");

    const result = await client.callTool({
      name: "pqdb_reset_branch",
      arguments: { project_id: "proj-123", name: "feature-x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("not found");
  });
});
