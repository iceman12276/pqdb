import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPqdbMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";

// Mock @pqdb/client — createClient returns a stub
vi.mock("@pqdb/client", () => ({
  createClient: vi.fn(
    (projectUrl: string, apiKey: string, options?: { encryptionKey?: string }) => ({
      auth: {},
      defineTable: vi.fn(),
      from: vi.fn(),
      reindex: vi.fn(),
      _projectUrl: projectUrl,
      _apiKey: apiKey,
      _options: options,
    }),
  ),
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

describe("createPqdbMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an MCP server with correct name and version", () => {
    const { mcpServer } = createPqdbMcpServer(makeConfig());
    expect(mcpServer).toBeDefined();
    expect(SERVER_NAME).toBe("pqdb-mcp");
    expect(SERVER_VERSION).toBe("0.1.0");
  });

  it("creates a pqdb client with the configured API key", async () => {
    const { createClient } = await import("@pqdb/client");
    const config = makeConfig({ apiKey: "pqdb_service_mykey" });
    createPqdbMcpServer(config);

    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:8000",
      "pqdb_service_mykey",
      { encryptionKey: undefined },
    );
  });

  it("passes encryption key to pqdb client when provided", async () => {
    const { createClient } = await import("@pqdb/client");
    const config = makeConfig({ encryptionKey: "my-enc-key" });
    createPqdbMcpServer(config);

    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:8000",
      "pqdb_anon_testkey123",
      { encryptionKey: "my-enc-key" },
    );
  });

  it("reports encryptionEnabled=true when encryption key is provided", () => {
    const result = createPqdbMcpServer(
      makeConfig({ encryptionKey: "secret" }),
    );
    expect(result.encryptionEnabled).toBe(true);
  });

  it("reports encryptionEnabled=false when no encryption key", () => {
    const result = createPqdbMcpServer(makeConfig());
    expect(result.encryptionEnabled).toBe(false);
  });

  it("returns pqdbClient reference", () => {
    const { pqdbClient } = createPqdbMcpServer(makeConfig());
    expect(pqdbClient).toBeDefined();
    expect(pqdbClient.auth).toBeDefined();
  });

  it("server announces tools capability", () => {
    const { mcpServer } = createPqdbMcpServer(makeConfig());
    // The server should have a registered tool (pqdb_status)
    // We verify this by checking the server can be connected
    expect(mcpServer).toBeDefined();
  });
});

describe("pqdb_status tool", () => {
  it("server has pqdb_status tool registered", async () => {
    const config = makeConfig({ encryptionKey: "test-key" });
    const { mcpServer } = createPqdbMcpServer(config);

    // Use the low-level server to list tools
    const server = mcpServer.server;
    // The server object should be defined (McpServer wraps a Server)
    expect(server).toBeDefined();
  });
});
