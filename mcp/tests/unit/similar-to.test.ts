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

describe("pqdb_query_rows similar_to parameter", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("pqdb_query_rows accepts similar_to parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_query_rows");
    const props = tool?.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("similar_to");
  });

  it("sends similar_to in the request body when provided", async () => {
    mockFetchOk({ data: [{ id: "1", title: "hello" }] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: {
        table: "docs",
        similar_to: {
          column: "embedding",
          vector: [0.1, 0.2, 0.3],
          limit: 5,
          distance: "cosine",
        },
      },
    });

    const callArgs = mockFetch.mock.calls[0] as unknown[];
    const body = JSON.parse((callArgs[1] as { body: string }).body);
    expect(body.similar_to).toEqual({
      column: "embedding",
      vector: [0.1, 0.2, 0.3],
      limit: 5,
      distance: "cosine",
    });
  });

  it("omits similar_to from body when not provided", async () => {
    mockFetchOk({ data: [] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "docs" },
    });

    const callArgs = mockFetch.mock.calls[0] as unknown[];
    const body = JSON.parse((callArgs[1] as { body: string }).body);
    expect(body.similar_to).toBeUndefined();
  });

  it("returns query results with similar_to", async () => {
    const rows = [
      { id: "1", title: "closest match", _distance: 0.1 },
      { id: "2", title: "second match", _distance: 0.3 },
    ];
    mockFetchOk({ data: rows });

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: {
        table: "docs",
        similar_to: {
          column: "embedding",
          vector: [0.1, 0.2, 0.3],
        },
      },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(rows);
    expect(parsed.error).toBeNull();
  });
});
