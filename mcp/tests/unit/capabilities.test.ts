import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPqdbMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "../../src/server.js";
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

describe("MCP server capabilities announcement", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { mcpServer } = createPqdbMcpServer(makeConfig());

    // Create in-memory transport pair for testing
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    // Connect server and client
    await mcpServer.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  it("server identifies as pqdb-mcp with correct version", async () => {
    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe(SERVER_NAME);
    expect(serverInfo?.version).toBe(SERVER_VERSION);
  });

  it("announces tools capability", async () => {
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
  });

  it("announces resources capability", async () => {
    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeDefined();
  });

  it("lists pqdb_status tool", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_status");
  });

  it("pqdb_status tool returns server info", async () => {
    const result = await client.callTool({ name: "pqdb_status", arguments: {} });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.server).toBe("pqdb-mcp");
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.projectUrl).toBe("http://localhost:8000");
    expect(parsed.encryptionEnabled).toBe(false);
    expect(parsed.transport).toBe("stdio");
  });

  it("pqdb_status reports encryption enabled when key provided", async () => {
    // Create a new server with encryption key
    const { mcpServer } = createPqdbMcpServer(
      makeConfig({ encryptionKey: "test-key" }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    const c = new Client({ name: "test", version: "1.0.0" });
    await c.connect(ct);

    const result = await c.callTool({ name: "pqdb_status", arguments: {} });
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.encryptionEnabled).toBe(true);
  });
});
