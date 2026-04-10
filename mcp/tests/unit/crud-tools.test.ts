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
  ColumnDef: class ColumnDef {
    type: string;
    sensitivity: string;
    constructor(type: string, sensitivity: string) {
      this.type = type;
      this.sensitivity = sensitivity;
    }
  },
  defineTableSchema: vi.fn((name: string, columns: Record<string, unknown>) => ({
    name,
    columns,
  })),
  deriveKeyPair: vi.fn(),
  transformInsertRows: vi.fn(),
  transformSelectResponse: vi.fn(),
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

// ── pqdb_query_rows ─────────────────────────────────────────────────

describe("pqdb_query_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_query_rows");
  });

  it("has a required table parameter", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_query_rows");
    expect(tool?.inputSchema.required).toContain("table");
  });

  it("calls POST /v1/db/{table}/select with correct body", async () => {
    mockFetchOk({ data: [{ id: "1", name: "Alice" }] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: {
        table: "users",
        columns: ["id", "name"],
        filters: [{ column: "id", op: "eq", value: "1" }],
        limit: 10,
        offset: 0,
        order_by: "name",
        order_dir: "asc",
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/select",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_anon_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          columns: ["id", "name"],
          filters: [{ column: "id", op: "eq", value: "1" }],
          modifiers: { limit: 10, offset: 0, order_by: "name", order_dir: "asc" },
        }),
      },
    );
  });

  it("returns { data, error: null } on success", async () => {
    const rows = [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }];
    mockFetchOk({ data: rows });

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(rows);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(404, "Table 'missing' not found");

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "missing" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("not found");
  });

  it("defaults to all columns when columns not provided", async () => {
    mockFetchOk({ data: [] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users" },
    });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as unknown[])[1] &&
        ((mockFetch.mock.calls[0] as unknown[])[1] as { body: string }).body,
    );
    expect(body.columns).toEqual(["*"]);
  });

  it("includes x-branch header when branch parameter is provided", async () => {
    mockFetchOk({ data: [{ id: "1" }] });

    await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users", branch: "feature-x" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/select",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-branch": "feature-x",
        }),
      }),
    );
  });

  it("replaces encrypted values with [encrypted] when no encryption key", async () => {
    mockFetchOk({
      data: [
        {
          id: "1",
          email_encrypted: "base64ciphertext==",
          email_index: "hmac_hash",
          name: "Alice",
        },
      ],
    });

    const result = await client.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "users" },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data[0].email_encrypted).toBe("[encrypted]");
    expect(parsed.data[0].name).toBe("Alice");
  });
});

// ── pqdb_insert_rows ────────────────────────────────────────────────

describe("pqdb_insert_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_insert_rows");
  });

  it("has required table and rows parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_insert_rows");
    expect(tool?.inputSchema.required).toContain("table");
    expect(tool?.inputSchema.required).toContain("rows");
  });

  it("calls POST /v1/db/{table}/insert with correct body", async () => {
    const rows = [{ name: "Alice" }, { name: "Bob" }];
    // First call: introspect (encryption check), second call: actual insert
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchOk({ data: rows });

    await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows },
    });

    const insertCall = mockFetch.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/insert"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toBe("http://localhost:8000/v1/db/users/insert");
    expect((insertCall![1] as { method: string }).method).toBe("POST");
    expect(JSON.parse((insertCall![1] as { body: string }).body)).toEqual({ rows });
  });

  it("returns { data, error: null } on success", async () => {
    const inserted = [{ id: "1", name: "Alice" }];
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchOk({ data: inserted });

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows: [{ name: "Alice" }] },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(inserted);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(400, "Must provide at least one row");

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows: [] },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("at least one row");
  });

  it("errors when rows contain _encrypted columns without encryption key", async () => {
    // Introspect returns a table with a searchable (encrypted) column
    mockFetchOk({
      tables: [{
        name: "users",
        columns: [
          { name: "name", type: "text", sensitivity: "plain" },
          { name: "email", type: "text", sensitivity: "searchable" },
        ],
      }],
    });

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: {
        table: "users",
        rows: [{ email: "some_value", name: "Alice" }],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("encryption");
  });

  it("includes x-branch header when branch parameter is provided", async () => {
    // First call: introspect (encryption check), second call: actual insert
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchOk({ data: [{ id: "1", name: "Alice" }] });

    await client.callTool({
      name: "pqdb_insert_rows",
      arguments: { table: "users", rows: [{ name: "Alice" }], branch: "dev" },
    });

    // The second call (insert) should have the x-branch header
    const insertCall = mockFetch.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/insert"),
    );
    expect(insertCall).toBeDefined();
    expect((insertCall![1] as { headers: Record<string, string> }).headers["x-branch"]).toBe("dev");
  });
});

// ── pqdb_update_rows ────────────────────────────────────────────────

describe("pqdb_update_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_update_rows");
  });

  it("has required table and values parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_update_rows");
    expect(tool?.inputSchema.required).toContain("table");
    expect(tool?.inputSchema.required).toContain("values");
  });

  it("calls POST /v1/db/{table}/update with correct body", async () => {
    // First call: introspect (encryption check), second call: actual update
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchOk({ data: [{ id: "1", name: "Bob" }] });

    await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { name: "Bob" },
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    const updateCall = mockFetch.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/update"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toBe("http://localhost:8000/v1/db/users/update");
    expect((updateCall![1] as { method: string }).method).toBe("POST");
    expect(JSON.parse((updateCall![1] as { body: string }).body)).toEqual({
      values: { name: "Bob" },
      filters: [{ column: "id", op: "eq", value: "1" }],
    });
  });

  it("returns { data, error: null } on success", async () => {
    const updated = [{ id: "1", name: "Bob" }];
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchOk({ data: updated });

    const result = await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { name: "Bob" },
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(updated);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    // introspect succeeds, but the update itself fails
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchError(400, "Must provide values to update");

    const result = await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: {},
        filters: [],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("values to update");
  });

  it("errors when values contain _encrypted columns without encryption key", async () => {
    mockFetchOk({
      tables: [{
        name: "users",
        columns: [
          { name: "name", type: "text", sensitivity: "plain" },
          { name: "email", type: "text", sensitivity: "searchable" },
        ],
      }],
    });

    const result = await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { email: "some_value" },
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain("encryption");
  });

  it("includes x-branch header when branch parameter is provided", async () => {
    // First call: introspect (encryption check), second call: actual update
    mockFetchOk({
      tables: [{ name: "users", columns: [{ name: "name", type: "text", sensitivity: "plain" }] }],
    });
    mockFetchOk({ data: [{ id: "1", name: "Updated" }] });

    await client.callTool({
      name: "pqdb_update_rows",
      arguments: {
        table: "users",
        values: { name: "Updated" },
        filters: [{ column: "id", op: "eq", value: "1" }],
        branch: "staging",
      },
    });

    const updateCall = mockFetch.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/update"),
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as { headers: Record<string, string> }).headers["x-branch"]).toBe("staging");
  });
});

// ── pqdb_delete_rows ────────────────────────────────────────────────

describe("pqdb_delete_rows tool", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  it("is registered and listed", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("pqdb_delete_rows");
  });

  it("has required table and filters parameters", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "pqdb_delete_rows");
    expect(tool?.inputSchema.required).toContain("table");
    expect(tool?.inputSchema.required).toContain("filters");
  });

  it("calls POST /v1/db/{table}/delete with correct body", async () => {
    mockFetchOk({ data: [{ id: "1" }] });

    await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/delete",
      {
        method: "POST",
        headers: {
          apikey: "pqdb_anon_testkey123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: [{ column: "id", op: "eq", value: "1" }],
        }),
      },
    );
  });

  it("returns { data, error: null } on success", async () => {
    const deleted = [{ id: "1", name: "Alice" }];
    mockFetchOk({ data: deleted });

    const result = await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [{ column: "id", op: "eq", value: "1" }],
      },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toEqual(deleted);
    expect(parsed.error).toBeNull();
  });

  it("returns { data: null, error } on API failure", async () => {
    mockFetchError(400, "At least one filter is required");

    const result = await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("filter");
  });

  it("includes x-branch header when branch parameter is provided", async () => {
    mockFetchOk({ data: [{ id: "1" }] });

    await client.callTool({
      name: "pqdb_delete_rows",
      arguments: {
        table: "users",
        filters: [{ column: "id", op: "eq", value: "1" }],
        branch: "feature-x",
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/db/users/delete",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-branch": "feature-x",
        }),
      }),
    );
  });
});

// ── US-008 wiring: CRUD consumes the per-project shared secret ─────────────

describe("US-008 — crud-tools consume the per-project shared secret", () => {
  it("pqdb_insert_rows uses the base64url-encoded shared secret, not PQDB_ENCRYPTION_KEY", async () => {
    // This is the regression test for the defect found in PR #149 review:
    // pqdb_create_project set a shared secret in auth-state, but CRUD tools
    // continued to derive keys from the legacy PQDB_ENCRYPTION_KEY env var.
    // After the fix, when a shared secret is present, crud-tools MUST pass
    // its base64url-encoded form to deriveKeyPair — even when no legacy
    // encryptionKey is configured.
    const { deriveKeyPair, transformInsertRows } = await import("@pqdb/client");
    const deriveKeyPairMock = vi.mocked(deriveKeyPair);
    const transformInsertRowsMock = vi.mocked(transformInsertRows);
    const {
      setCurrentSharedSecret,
      clearCurrentSharedSecret,
      getCurrentEncryptionKeyString,
    } = await import("../../src/auth-state.js");

    vi.clearAllMocks();
    clearCurrentSharedSecret();

    // Pretend deriveKeyPair returned something usable; actual bytes don't matter
    deriveKeyPairMock.mockResolvedValue({
      publicKey: new Uint8Array(1184),
      secretKey: new Uint8Array(2400),
    });
    transformInsertRowsMock.mockResolvedValue([{ email_encrypted: "X", email_index: "Y" }]);

    // Start a client with NO legacy encryptionKey — the only key source
    // should be the dynamic shared secret from auth-state. createPqdbMcpServer
    // clears both the private key and shared secret during construction, so
    // we MUST set the shared secret AFTER creating the client, not before.
    const client = await createTestClient({ encryptionKey: undefined });

    // Deterministic 32-byte shared secret (US-008 uses ML-KEM-768 shared secrets)
    const ss = new Uint8Array(32);
    for (let i = 0; i < 32; i++) ss[i] = i;
    setCurrentSharedSecret(ss);

    // 1st mocked fetch: introspect (table has a searchable column)
    mockFetchOk({
      tables: [{
        name: "users",
        columns: [
          { name: "email", type: "text", sensitivity: "searchable" },
        ],
      }],
    });
    // 2nd mocked fetch: HMAC key retrieval for blind-index HMAC
    mockFetchOk({
      current_version: 1,
      keys: { "1": "aa".repeat(32) }, // 64 hex chars = 32 bytes
    });
    // 3rd mocked fetch: the actual insert POST
    mockFetchOk({ data: [{ id: "row-1" }] });

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: {
        table: "users",
        rows: [{ email: "alice@test.com" }],
      },
    });

    expect(result.isError).toBeFalsy();

    // CORE ASSERTION: deriveKeyPair must have been called with the
    // base64url-encoded shared secret, NOT with the legacy env var.
    expect(deriveKeyPairMock).toHaveBeenCalled();
    const expectedKeyString = getCurrentEncryptionKeyString();
    expect(expectedKeyString).not.toBeNull();
    expect(expectedKeyString!.length).toBe(43); // 32 bytes -> base64url-no-pad
    expect(deriveKeyPairMock).toHaveBeenCalledWith(expectedKeyString);

    // And the input string must NOT be the legacy env var — the test
    // configures the client with encryptionKey: undefined, so any passed
    // value is by definition the dynamic one. Defense in depth:
    const callArgs = deriveKeyPairMock.mock.calls.map((c) => c[0]);
    for (const arg of callArgs) {
      expect(arg).toBe(expectedKeyString);
    }

    // And transformInsertRows must have been called — the encrypted write
    // path actually ran, rather than being rejected with "encryption not
    // available".
    expect(transformInsertRowsMock).toHaveBeenCalled();

    clearCurrentSharedSecret();
  });

  it("without a shared secret AND without PQDB_ENCRYPTION_KEY, encrypted columns are rejected", async () => {
    const {
      clearCurrentSharedSecret,
    } = await import("../../src/auth-state.js");

    vi.clearAllMocks();
    clearCurrentSharedSecret();

    const client = await createTestClient({ encryptionKey: undefined });

    // Introspect returns a table with a searchable column
    mockFetchOk({
      tables: [{
        name: "users",
        columns: [
          { name: "email", type: "text", sensitivity: "searchable" },
        ],
      }],
    });

    const result = await client.callTool({
      name: "pqdb_insert_rows",
      arguments: {
        table: "users",
        rows: [{ email: "alice@test.com" }],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("encryption");
  });
});
