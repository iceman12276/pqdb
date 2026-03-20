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

// ── pqdb_get_project ────────────────────────────────────────────────

describe("pqdb_get_project tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_get_project");
  });

  it("has a required project_id parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_get_project");
    expect(tool?.inputSchema.required).toContain("project_id");
  });

  it("calls GET /v1/projects/{id} with apikey header", async () => {
    const project = {
      id: "proj-123",
      name: "My Project",
      status: "active",
      region: "us-east-1",
      database_name: "pqdb_project_abc",
      created_at: "2026-01-01T00:00:00Z",
    };
    mockFetchOk(project);

    const result = await client.callTool({
      name: "pqdb_get_project",
      arguments: { project_id: "proj-123" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123",
      {
        method: "GET",
        headers: { apikey: "pqdb_service_testkey123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(project);
    expect(parsed.error).toBeNull();
  });

  it("returns error on API failure", async () => {
    mockFetchError(404, "Project not found");

    const result = await client.callTool({
      name: "pqdb_get_project",
      arguments: { project_id: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("not found");
  });
});

// ── pqdb_list_projects ──────────────────────────────────────────────

describe("pqdb_list_projects tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_list_projects");
  });

  it("calls GET /v1/projects with Authorization header", async () => {
    const projects = [
      { id: "p1", name: "Project 1", status: "active" },
      { id: "p2", name: "Project 2", status: "paused" },
    ];
    mockFetchOk(projects);

    const result = await client.callTool({
      name: "pqdb_list_projects",
      arguments: {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects",
      {
        method: "GET",
        headers: { Authorization: "Bearer dev-jwt-token-123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(projects);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_list_projects",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });
});

// ── pqdb_create_project ─────────────────────────────────────────────

describe("pqdb_create_project tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_create_project");
  });

  it("has required name parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_create_project");
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("calls POST /v1/projects with Authorization header and body", async () => {
    const created = {
      id: "proj-new",
      name: "New Project",
      region: "us-east-1",
      status: "active",
    };
    mockFetchOk(created);

    const result = await client.callTool({
      name: "pqdb_create_project",
      arguments: { name: "New Project", region: "us-east-1" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-jwt-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "New Project", region: "us-east-1" }),
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(created);
    expect(parsed.error).toBeNull();
  });

  it("returns error when devToken is not set", async () => {
    vi.clearAllMocks();
    const clientNoToken = await createTestClient({ devToken: undefined });

    const result = await clientNoToken.callTool({
      name: "pqdb_create_project",
      arguments: { name: "New Project" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });

  it("returns error on API failure", async () => {
    mockFetchError(400, "Project name already exists");

    const result = await client.callTool({
      name: "pqdb_create_project",
      arguments: { name: "Duplicate" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("already exists");
  });
});

// ── pqdb_get_logs ───────────────────────────────────────────────────

describe("pqdb_get_logs tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_get_logs");
  });

  it("has a required project_id parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_get_logs");
    expect(tool?.inputSchema.required).toContain("project_id");
  });

  it("calls GET /v1/projects/{id}/logs with apikey header", async () => {
    const logs = [
      { id: "l1", action: "insert", table: "users", timestamp: "2026-01-01T00:00:00Z" },
      { id: "l2", action: "select", table: "posts", timestamp: "2026-01-01T01:00:00Z" },
    ];
    mockFetchOk(logs);

    const result = await client.callTool({
      name: "pqdb_get_logs",
      arguments: { project_id: "proj-123" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/logs",
      {
        method: "GET",
        headers: { apikey: "pqdb_service_testkey123" },
      },
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(logs);
    expect(parsed.error).toBeNull();
  });

  it("returns error on API failure", async () => {
    mockFetchError(403, "Forbidden");

    const result = await client.callTool({
      name: "pqdb_get_logs",
      arguments: { project_id: "proj-123" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("Forbidden");
  });
});

// ── pqdb_pause_project ──────────────────────────────────────────────

describe("pqdb_pause_project tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_pause_project");
  });

  it("calls POST /v1/projects/{id}/pause with Authorization header", async () => {
    const response = { id: "proj-123", status: "paused" };
    mockFetchOk(response);

    const result = await client.callTool({
      name: "pqdb_pause_project",
      arguments: { project_id: "proj-123" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/pause",
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
      name: "pqdb_pause_project",
      arguments: { project_id: "proj-123" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });
});

// ── pqdb_restore_project ────────────────────────────────────────────

describe("pqdb_restore_project tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient({ devToken: "dev-jwt-token-123" });
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_restore_project");
  });

  it("calls POST /v1/projects/{id}/restore with Authorization header", async () => {
    const response = { id: "proj-123", status: "active" };
    mockFetchOk(response);

    const result = await client.callTool({
      name: "pqdb_restore_project",
      arguments: { project_id: "proj-123" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/projects/proj-123/restore",
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
      name: "pqdb_restore_project",
      arguments: { project_id: "proj-123" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("PQDB_DEV_TOKEN");
  });
});
