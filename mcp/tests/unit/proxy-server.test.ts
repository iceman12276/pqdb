/**
 * Integration tests for createCryptoProxyServer (US-013).
 *
 * Uses in-process transports with a mock hosted MCP server to verify:
 * - Dynamic tool registration from upstream
 * - Non-crypto tool passthrough
 * - Crypto tool interception (transformRequest → callTool → transformResponse)
 * - Full proxy lifecycle
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import {
  createCryptoProxyServer,
  type ProxyConfig,
} from "../../src/proxy/proxy-server.js";
import type { UpstreamClient, ToolInfo, CallToolResult } from "../../src/proxy/upstream-client.js";
import { CryptoInterceptor, isCryptoTool } from "../../src/proxy/crypto-interceptor.js";

// ── Mock UpstreamClient ──────────────────────────────────────────────────

const mockUpstreamConnect = vi.fn().mockResolvedValue(undefined);
const mockUpstreamListTools = vi.fn<() => Promise<ToolInfo[]>>();
const mockUpstreamCallTool = vi.fn<(name: string, args: Record<string, unknown>) => Promise<CallToolResult>>();
const mockUpstreamClose = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/proxy/upstream-client.js", () => ({
  UpstreamClient: vi.fn().mockImplementation(() => ({
    connect: mockUpstreamConnect,
    listTools: mockUpstreamListTools,
    callTool: mockUpstreamCallTool,
    close: mockUpstreamClose,
  })),
}));

// ── Mock CryptoInterceptor ───────────────────────────────────────────────

const mockTransformRequest = vi.fn<(toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const mockTransformResponse = vi.fn();

vi.mock("../../src/proxy/crypto-interceptor.js", () => ({
  CryptoInterceptor: vi.fn().mockImplementation(() => ({
    transformRequest: mockTransformRequest,
    transformResponse: mockTransformResponse,
  })),
  isCryptoTool: vi.fn((name: string) => {
    const CRYPTO_TOOLS = new Set([
      "pqdb_insert_rows",
      "pqdb_query_rows",
      "pqdb_update_rows",
      "pqdb_delete_rows",
      "pqdb_create_project",
      "pqdb_select_project",
      "pqdb_natural_language_query",
    ]);
    return CRYPTO_TOOLS.has(name);
  }),
}));

// ── Test fixtures ────────────────────────────────────────────────────────

const FAKE_PRIVATE_KEY = new Uint8Array(2400).fill(0xaa);
const FAKE_CONFIG: ProxyConfig = {
  targetUrl: "http://localhost:3000/mcp",
  privateKey: FAKE_PRIVATE_KEY,
  backendUrl: "http://localhost:8000",
  authToken: "test-jwt-token",
};

const UPSTREAM_TOOLS: ToolInfo[] = [
  {
    name: "pqdb_list_tables",
    description: "List all tables in the project",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pqdb_insert_rows",
    description: "Insert rows into a table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        rows: { type: "array" },
      },
      required: ["table", "rows"],
    },
  },
  {
    name: "pqdb_query_rows",
    description: "Query rows from a table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        columns: { type: "array" },
        filters: { type: "array" },
      },
      required: ["table"],
    },
  },
  {
    name: "pqdb_create_project",
    description: "Create a new project",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
];

// ── Tests ────────────────────────────────────────────────────────────────

describe("createCryptoProxyServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpstreamListTools.mockResolvedValue(UPSTREAM_TOOLS);
  });

  it("connects to upstream and returns mcpServer + upstream", async () => {
    const result = await createCryptoProxyServer(FAKE_CONFIG);

    expect(result.mcpServer).toBeInstanceOf(McpServer);
    expect(result.upstream).toBeDefined();
    expect(mockUpstreamConnect).toHaveBeenCalledOnce();
    expect(mockUpstreamListTools).toHaveBeenCalledOnce();
  });

  it("registers all upstream tools on the local McpServer", async () => {
    const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

    // Connect a test client to the proxy to verify tool listing
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const testClient = new Client(
      { name: "test-client", version: "0.1.0" },
      { capabilities: {} },
    );

    await mcpServer.connect(serverTransport);
    await testClient.connect(clientTransport);

    const tools = await testClient.listTools();

    expect(tools.tools).toHaveLength(UPSTREAM_TOOLS.length);

    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("pqdb_list_tables");
    expect(toolNames).toContain("pqdb_insert_rows");
    expect(toolNames).toContain("pqdb_query_rows");
    expect(toolNames).toContain("pqdb_create_project");

    await testClient.close();
    await mcpServer.close();
  });

  it("preserves tool descriptions from upstream", async () => {
    const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const testClient = new Client(
      { name: "test-client", version: "0.1.0" },
      { capabilities: {} },
    );
    await mcpServer.connect(serverTransport);
    await testClient.connect(clientTransport);

    const tools = await testClient.listTools();
    const listTablesTool = tools.tools.find(
      (t) => t.name === "pqdb_list_tables",
    );
    expect(listTablesTool?.description).toBe(
      "List all tables in the project",
    );

    await testClient.close();
    await mcpServer.close();
  });

  describe("non-crypto tool passthrough", () => {
    it("forwards args directly to upstream without interception", async () => {
      mockUpstreamCallTool.mockResolvedValue({
        content: [{ type: "text", text: '{"tables":["users","posts"]}' }],
      });
      // Non-crypto tool should NOT call interceptor transforms,
      // but the proxy still calls transformRequest/transformResponse which
      // will return args unchanged for non-crypto tools
      mockTransformRequest.mockImplementation(async (_name, args) => args);
      mockTransformResponse.mockImplementation(async (_name, result) => result);

      const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const testClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await testClient.connect(clientTransport);

      const result = await testClient.callTool({
        name: "pqdb_list_tables",
        arguments: {},
      });

      expect(mockUpstreamCallTool).toHaveBeenCalledWith("pqdb_list_tables", {});
      expect(result.content).toEqual([
        { type: "text", text: '{"tables":["users","posts"]}' },
      ]);

      await testClient.close();
      await mcpServer.close();
    });
  });

  describe("crypto tool interception — insert with encryption", () => {
    it("calls transformRequest before upstream.callTool and transformResponse after", async () => {
      const originalArgs = {
        table: "users",
        rows: [{ email: "alice@example.com" }],
      };
      const transformedArgs = {
        table: "users",
        rows: [{ email_encrypted: "enc-data", email_index: "hmac-hash" }],
      };
      const upstreamResult: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ data: { inserted: 1 }, error: null }),
          },
        ],
      };

      mockTransformRequest.mockResolvedValue(transformedArgs);
      mockUpstreamCallTool.mockResolvedValue(upstreamResult);
      mockTransformResponse.mockResolvedValue(upstreamResult);

      const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const testClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await testClient.connect(clientTransport);

      await testClient.callTool({
        name: "pqdb_insert_rows",
        arguments: originalArgs,
      });

      // Verify the pipeline: transformRequest → callTool → transformResponse
      expect(mockTransformRequest).toHaveBeenCalledWith(
        "pqdb_insert_rows",
        originalArgs,
      );
      expect(mockUpstreamCallTool).toHaveBeenCalledWith(
        "pqdb_insert_rows",
        transformedArgs,
      );
      expect(mockTransformResponse).toHaveBeenCalledWith(
        "pqdb_insert_rows",
        upstreamResult,
        expect.objectContaining({ table: "users" }),
      );

      await testClient.close();
      await mcpServer.close();
    });
  });

  describe("crypto tool interception — query with decryption", () => {
    it("transforms query filters and decrypts response", async () => {
      const originalArgs = {
        table: "users",
        columns: ["*"],
        filters: [{ column: "email", op: "eq", value: "alice@example.com" }],
      };
      const transformedArgs = {
        table: "users",
        columns: ["*"],
        filters: [{ column: "email_index", op: "eq", value: "hmac-hash" }],
      };
      const upstreamResult: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: [{ id: "1", email_encrypted: "enc-bytes" }],
              error: null,
            }),
          },
        ],
      };
      const decryptedResult: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: [{ id: "1", email: "alice@example.com" }],
              error: null,
            }),
          },
        ],
      };

      mockTransformRequest.mockResolvedValue(transformedArgs);
      mockUpstreamCallTool.mockResolvedValue(upstreamResult);
      mockTransformResponse.mockResolvedValue(decryptedResult);

      const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const testClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await testClient.connect(clientTransport);

      const result = await testClient.callTool({
        name: "pqdb_query_rows",
        arguments: originalArgs,
      });

      // Verify pipeline
      expect(mockTransformRequest).toHaveBeenCalledWith(
        "pqdb_query_rows",
        originalArgs,
      );
      expect(mockUpstreamCallTool).toHaveBeenCalledWith(
        "pqdb_query_rows",
        transformedArgs,
      );

      // Verify the final response returned to client
      const textContent = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      );
      expect(textContent?.text).toBe(
        JSON.stringify({
          data: [{ id: "1", email: "alice@example.com" }],
          error: null,
        }),
      );

      await testClient.close();
      await mcpServer.close();
    });
  });

  describe("crypto tool interception — create_project with encapsulation", () => {
    it("transforms create_project request and response", async () => {
      const originalArgs = { name: "Encrypted Project" };
      const transformedArgs = {
        name: "Encrypted Project",
        wrapped_encryption_key: "base64-ciphertext",
      };
      const upstreamResult: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: { project: { id: "proj-new", name: "Encrypted Project" } },
              error: null,
            }),
          },
        ],
      };

      mockTransformRequest.mockResolvedValue(transformedArgs);
      mockUpstreamCallTool.mockResolvedValue(upstreamResult);
      mockTransformResponse.mockResolvedValue(upstreamResult);

      const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const testClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await testClient.connect(clientTransport);

      await testClient.callTool({
        name: "pqdb_create_project",
        arguments: originalArgs,
      });

      expect(mockTransformRequest).toHaveBeenCalledWith(
        "pqdb_create_project",
        originalArgs,
      );
      expect(mockUpstreamCallTool).toHaveBeenCalledWith(
        "pqdb_create_project",
        transformedArgs,
      );
      expect(mockTransformResponse).toHaveBeenCalledWith(
        "pqdb_create_project",
        upstreamResult,
        expect.objectContaining({ name: "Encrypted Project" }),
      );

      await testClient.close();
      await mcpServer.close();
    });
  });

  describe("dynamic tool registration", () => {
    it("new tools from upstream are registered without code changes", async () => {
      // Add a brand new tool that didn't exist before
      const extraTools: ToolInfo[] = [
        ...UPSTREAM_TOOLS,
        {
          name: "pqdb_new_custom_tool",
          description: "A newly added tool",
          inputSchema: {
            type: "object",
            properties: {
              foo: { type: "string" },
            },
          },
        },
      ];
      mockUpstreamListTools.mockResolvedValue(extraTools);

      const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const testClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await testClient.connect(clientTransport);

      const tools = await testClient.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain("pqdb_new_custom_tool");

      // Call the new tool — should pass through as non-crypto
      mockUpstreamCallTool.mockResolvedValue({
        content: [{ type: "text", text: '{"result":"custom"}' }],
      });
      mockTransformRequest.mockImplementation(async (_name, args) => args);
      mockTransformResponse.mockImplementation(async (_name, result) => result);

      const result = await testClient.callTool({
        name: "pqdb_new_custom_tool",
        arguments: { foo: "bar" },
      });

      expect(mockUpstreamCallTool).toHaveBeenCalledWith(
        "pqdb_new_custom_tool",
        { foo: "bar" },
      );

      await testClient.close();
      await mcpServer.close();
    });
  });

  describe("error handling", () => {
    it("propagates upstream connection errors", async () => {
      mockUpstreamConnect.mockRejectedValueOnce(
        new Error("Connection refused"),
      );

      await expect(createCryptoProxyServer(FAKE_CONFIG)).rejects.toThrow(
        "Connection refused",
      );
    });

    it("propagates upstream tool call errors through the proxy", async () => {
      mockUpstreamCallTool.mockRejectedValue(
        new Error("Upstream tool failed"),
      );
      mockTransformRequest.mockImplementation(async (_name, args) => args);

      const { mcpServer } = await createCryptoProxyServer(FAKE_CONFIG);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const testClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await testClient.connect(clientTransport);

      const result = await testClient.callTool({
        name: "pqdb_list_tables",
        arguments: {},
      });

      // The proxy should return an error result, not throw
      expect(result.isError).toBe(true);

      await testClient.close();
      await mcpServer.close();
    });
  });
});
