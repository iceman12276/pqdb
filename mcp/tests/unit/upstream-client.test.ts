/**
 * Unit tests for UpstreamClient — US-011
 *
 * Mocks the MCP SDK Client and StreamableHTTPClientTransport to verify
 * the connect/listTools/callTool/close lifecycle without hitting a real server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the MCP SDK modules before importing UpstreamClient ---

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    {
      name: "pqdb_status",
      description: "Check server status",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "pqdb_insert",
      description: "Insert a row",
      inputSchema: {
        type: "object" as const,
        properties: { table: { type: "string" } },
        required: ["table"],
      },
    },
  ],
});
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: "text", text: '{"ok":true}' }],
});
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

const mockTransportStart = vi.fn().mockResolvedValue(undefined);
const mockTransportClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    start: mockTransportStart,
    close: mockTransportClose,
  })),
}));

import { UpstreamClient } from "../../src/proxy/upstream-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("UpstreamClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("stores targetUrl and optional authHeaders", () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      expect(client).toBeDefined();
    });

    it("accepts optional authHeaders", () => {
      const client = new UpstreamClient("http://localhost:3000/mcp", {
        Authorization: "Bearer token123",
      });
      expect(client).toBeDefined();
    });
  });

  describe("connect()", () => {
    it("creates a StreamableHTTPClientTransport and connects the Client", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
      // Verify URL is constructed from targetUrl
      const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
        .calls;
      expect(transportCalls[0][0]).toBeInstanceOf(URL);
      expect(transportCalls[0][0].toString()).toBe(
        "http://localhost:3000/mcp",
      );

      expect(Client).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("passes authHeaders via requestInit to the transport", async () => {
      const headers = {
        Authorization: "Bearer secret",
        "X-Custom": "value",
      };
      const client = new UpstreamClient(
        "http://localhost:3000/mcp",
        headers,
      );
      await client.connect();

      const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
        .calls;
      expect(transportCalls[0][1]).toEqual(
        expect.objectContaining({
          requestInit: {
            headers,
          },
        }),
      );
    });

    it("does not pass requestInit when no authHeaders provided", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();

      const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
        .calls;
      // Second arg should be undefined or not contain requestInit with headers
      const opts = transportCalls[0][1];
      expect(opts).toBeUndefined();
    });

    it("throws with clear message on connection refused", async () => {
      mockConnect.mockRejectedValueOnce(new Error("fetch failed"));

      const client = new UpstreamClient("http://localhost:3000/mcp");
      await expect(client.connect()).rejects.toThrow(
        /failed to connect.*http:\/\/localhost:3000\/mcp/i,
      );
    });

    it("throws with clear message on timeout", async () => {
      const timeoutError = new Error("The operation was aborted");
      timeoutError.name = "AbortError";
      mockConnect.mockRejectedValueOnce(timeoutError);

      const client = new UpstreamClient("http://localhost:3000/mcp");
      await expect(client.connect()).rejects.toThrow(
        /timed out.*http:\/\/localhost:3000\/mcp/i,
      );
    });

    it("throws with clear message on auth failure (401/403)", async () => {
      const authError = new Error("Unauthorized");
      (authError as Record<string, unknown>).code = 401;
      mockConnect.mockRejectedValueOnce(authError);

      const client = new UpstreamClient("http://localhost:3000/mcp");
      await expect(client.connect()).rejects.toThrow(
        /auth.*failed.*http:\/\/localhost:3000\/mcp/i,
      );
    });
  });

  describe("listTools()", () => {
    it("returns tools with names, descriptions, and input schemas", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();

      const tools = await client.listTools();

      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(tools).toHaveLength(2);
      expect(tools[0]).toEqual({
        name: "pqdb_status",
        description: "Check server status",
        inputSchema: { type: "object", properties: {} },
      });
      expect(tools[1]).toEqual({
        name: "pqdb_insert",
        description: "Insert a row",
        inputSchema: {
          type: "object",
          properties: { table: { type: "string" } },
          required: ["table"],
        },
      });
    });

    it("throws if not connected", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await expect(client.listTools()).rejects.toThrow(/not connected/i);
    });
  });

  describe("callTool()", () => {
    it("forwards tool call and returns result", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();

      const result = await client.callTool("pqdb_insert", {
        table: "users",
      });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: "pqdb_insert",
        arguments: { table: "users" },
      });
      expect(result).toEqual({
        content: [{ type: "text", text: '{"ok":true}' }],
      });
    });

    it("throws if not connected", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await expect(
        client.callTool("pqdb_insert", { table: "users" }),
      ).rejects.toThrow(/not connected/i);
    });

    it("propagates errors from callTool", async () => {
      mockCallTool.mockRejectedValueOnce(new Error("tool execution failed"));

      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();

      await expect(
        client.callTool("bad_tool", {}),
      ).rejects.toThrow("tool execution failed");
    });
  });

  describe("close()", () => {
    it("cleanly disconnects the client", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();
      await client.close();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("is safe to call when not connected", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      // Should not throw
      await client.close();
    });

    it("prevents further operations after close", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp");
      await client.connect();
      await client.close();

      await expect(client.listTools()).rejects.toThrow(/not connected/i);
    });
  });

  describe("full lifecycle", () => {
    it("connect → listTools → callTool → close", async () => {
      const client = new UpstreamClient("http://localhost:3000/mcp", {
        Authorization: "Bearer test",
      });

      await client.connect();
      const tools = await client.listTools();
      expect(tools).toHaveLength(2);

      const result = await client.callTool("pqdb_status", {});
      expect(result.content).toBeDefined();

      await client.close();

      // Verify the full sequence of SDK calls
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
      expect(Client).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(mockCallTool).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
