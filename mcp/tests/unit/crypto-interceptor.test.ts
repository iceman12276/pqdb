/**
 * Unit tests for CryptoInterceptor (US-012).
 *
 * Verifies that the interceptor correctly routes each of the 7 crypto-relevant
 * tools to the right transform, and passes non-crypto tools through unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @pqdb/client crypto functions
const mockDeriveKeyPair = vi.fn();
const mockTransformInsertRows = vi.fn();
const mockTransformSelectResponse = vi.fn();
const mockTransformFilters = vi.fn();
const mockEncapsulate = vi.fn();
const mockDecapsulate = vi.fn();
const mockDefineTableSchema = vi.fn();

vi.mock("@pqdb/client", () => ({
  deriveKeyPair: (...args: unknown[]) => mockDeriveKeyPair(...args),
  transformInsertRows: (...args: unknown[]) => mockTransformInsertRows(...args),
  transformSelectResponse: (...args: unknown[]) => mockTransformSelectResponse(...args),
  transformFilters: (...args: unknown[]) => mockTransformFilters(...args),
  encapsulate: (...args: unknown[]) => mockEncapsulate(...args),
  decapsulate: (...args: unknown[]) => mockDecapsulate(...args),
  defineTableSchema: (...args: unknown[]) => mockDefineTableSchema(...args),
  ColumnDef: class ColumnDef {
    type: string;
    sensitivity: string;
    constructor(type: string, sensitivity: string) {
      this.type = type;
      this.sensitivity = sensitivity;
    }
  },
}));

// Mock global fetch for backend HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  CryptoInterceptor,
  isCryptoTool,
} from "../../src/proxy/crypto-interceptor.js";

// ── Test fixtures ─────────────────────────────────────────────────────

const FAKE_PRIVATE_KEY = new Uint8Array(2400).fill(0xaa);
const FAKE_SHARED_SECRET = new Uint8Array(32).fill(0xbb);
const FAKE_PUBLIC_KEY = new Uint8Array(1184).fill(0xcc);
const FAKE_CIPHERTEXT = new Uint8Array(1088).fill(0xdd);
const FAKE_KEY_PAIR = {
  publicKey: new Uint8Array(1184).fill(0x11),
  secretKey: new Uint8Array(2400).fill(0x22),
};
const FAKE_HMAC_KEY = new Uint8Array(32).fill(0x33);

const BACKEND_URL = "http://localhost:8000";
const AUTH_TOKEN = "test-jwt-token";

function createInterceptor(): CryptoInterceptor {
  return new CryptoInterceptor({
    privateKey: FAKE_PRIVATE_KEY,
    backendUrl: BACKEND_URL,
    authToken: AUTH_TOKEN,
  });
}

/** Mock a successful fetch response. */
function mockFetchOk(data: unknown): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

/** Build a fake introspection response with some encrypted columns. */
function mockIntrospectionResponse(): void {
  mockFetchOk({
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: "uuid", sensitivity: "plain" },
          { name: "email", type: "text", sensitivity: "searchable" },
          { name: "ssn", type: "text", sensitivity: "private" },
          { name: "age", type: "integer", sensitivity: "plain" },
        ],
      },
    ],
  });
}

/** Mock HMAC key fetch response. */
function mockHmacKeyResponse(): void {
  mockFetchOk({
    current_version: 1,
    keys: { "1": FAKE_HMAC_KEY.reduce((s, b) => s + b.toString(16).padStart(2, "0"), "") },
  });
}

// ── isCryptoTool ──────────────────────────────────────────────────────

describe("isCryptoTool", () => {
  it("returns true for pqdb_insert_rows", () => {
    expect(isCryptoTool("pqdb_insert_rows")).toBe(true);
  });

  it("returns true for pqdb_query_rows", () => {
    expect(isCryptoTool("pqdb_query_rows")).toBe(true);
  });

  it("returns true for pqdb_update_rows", () => {
    expect(isCryptoTool("pqdb_update_rows")).toBe(true);
  });

  it("returns true for pqdb_delete_rows", () => {
    expect(isCryptoTool("pqdb_delete_rows")).toBe(true);
  });

  it("returns true for pqdb_create_project", () => {
    expect(isCryptoTool("pqdb_create_project")).toBe(true);
  });

  it("returns true for pqdb_select_project", () => {
    expect(isCryptoTool("pqdb_select_project")).toBe(true);
  });

  it("returns true for pqdb_natural_language_query", () => {
    expect(isCryptoTool("pqdb_natural_language_query")).toBe(true);
  });

  it("returns false for non-crypto tools", () => {
    expect(isCryptoTool("pqdb_list_projects")).toBe(false);
    expect(isCryptoTool("pqdb_get_project")).toBe(false);
    expect(isCryptoTool("pqdb_create_table")).toBe(false);
    expect(isCryptoTool("some_other_tool")).toBe(false);
  });
});

// ── CryptoInterceptor: constructor ────────────────────────────────────

describe("CryptoInterceptor constructor", () => {
  it("creates an instance with required config", () => {
    const interceptor = createInterceptor();
    expect(interceptor).toBeInstanceOf(CryptoInterceptor);
  });

  it("starts with no shared secret", () => {
    const interceptor = createInterceptor();
    expect(interceptor.hasSharedSecret()).toBe(false);
  });
});

// ── transformRequest: pqdb_insert_rows ────────────────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_insert_rows", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    // Set shared secret so encryption is available
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);

    // Mock deriveKeyPair and schema/hmac fetches
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
        ssn: { type: "text", sensitivity: "private" },
        age: { type: "integer", sensitivity: "plain" },
      },
    });
  });

  it("encrypts rows using transformInsertRows", async () => {
    mockIntrospectionResponse();
    mockHmacKeyResponse();

    const transformedRows = [
      { id: "1", email: "encrypted-email", email_index: "hmac-hash", ssn: "encrypted-ssn", age: 30 },
    ];
    mockTransformInsertRows.mockResolvedValue(transformedRows);

    const args = {
      table: "users",
      rows: [{ id: "1", email: "alice@example.com", ssn: "123-45-6789", age: 30 }],
    };

    const result = await interceptor.transformRequest("pqdb_insert_rows", args);

    expect(mockTransformInsertRows).toHaveBeenCalledOnce();
    expect(result.rows).toEqual(transformedRows);
    expect(result.table).toBe("users");
  });

  it("passes through when no shared secret is set", async () => {
    interceptor = createInterceptor(); // No shared secret
    const args = {
      table: "users",
      rows: [{ id: "1", age: 30 }],
    };

    const result = await interceptor.transformRequest("pqdb_insert_rows", args);
    expect(result).toEqual(args);
    expect(mockTransformInsertRows).not.toHaveBeenCalled();
  });
});

// ── transformRequest: pqdb_query_rows ─────────────────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_query_rows", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
        ssn: { type: "text", sensitivity: "private" },
        age: { type: "integer", sensitivity: "plain" },
      },
    });
  });

  it("transforms filters using transformFilters", async () => {
    mockIntrospectionResponse();
    mockHmacKeyResponse();

    const transformedFilters = [{ column: "email", op: "eq", value: "hmac-hash-value" }];
    mockTransformFilters.mockReturnValue(transformedFilters);

    const args = {
      table: "users",
      filters: [{ column: "email", op: "eq", value: "alice@example.com" }],
    };

    const result = await interceptor.transformRequest("pqdb_query_rows", args);

    expect(mockTransformFilters).toHaveBeenCalledOnce();
    expect(result.filters).toEqual(transformedFilters);
  });

  it("does not transform when no filters present", async () => {
    mockIntrospectionResponse();
    // No HMAC key fetch needed since no filters
    const args = { table: "users", columns: ["*"] };

    const result = await interceptor.transformRequest("pqdb_query_rows", args);
    expect(mockTransformFilters).not.toHaveBeenCalled();
    expect(result.table).toBe("users");
  });
});

// ── transformRequest: pqdb_update_rows ────────────────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_update_rows", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
        ssn: { type: "text", sensitivity: "private" },
        age: { type: "integer", sensitivity: "plain" },
      },
    });
  });

  it("encrypts values and transforms filters", async () => {
    mockIntrospectionResponse();
    mockHmacKeyResponse();

    const transformedValues = [{ email: "enc-email", email_index: "hmac", ssn: "enc-ssn" }];
    mockTransformInsertRows.mockResolvedValue(transformedValues);
    const transformedFilters = [{ column: "email", op: "eq", value: "hmac-val" }];
    mockTransformFilters.mockReturnValue(transformedFilters);

    const args = {
      table: "users",
      values: { email: "bob@example.com", ssn: "999-88-7777" },
      filters: [{ column: "email", op: "eq", value: "alice@example.com" }],
    };

    const result = await interceptor.transformRequest("pqdb_update_rows", args);

    expect(mockTransformInsertRows).toHaveBeenCalledOnce();
    expect(mockTransformFilters).toHaveBeenCalledOnce();
    expect(result.values).toEqual(transformedValues[0]);
    expect(result.filters).toEqual(transformedFilters);
  });
});

// ── transformRequest: pqdb_delete_rows ────────────────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_delete_rows", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
      },
    });
  });

  it("transforms filters for delete", async () => {
    mockIntrospectionResponse();
    mockHmacKeyResponse();

    const transformedFilters = [{ column: "email", op: "eq", value: "hmac-delete" }];
    mockTransformFilters.mockReturnValue(transformedFilters);

    const args = {
      table: "users",
      filters: [{ column: "email", op: "eq", value: "alice@example.com" }],
    };

    const result = await interceptor.transformRequest("pqdb_delete_rows", args);

    expect(mockTransformFilters).toHaveBeenCalledOnce();
    expect(result.filters).toEqual(transformedFilters);
  });
});

// ── transformRequest: pqdb_create_project ─────────────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_create_project", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("fetches public key, encapsulates, and adds wrapped_encryption_key", async () => {
    // Mock public key fetch
    mockFetchOk({ public_key: Buffer.from(FAKE_PUBLIC_KEY).toString("base64") });

    mockEncapsulate.mockResolvedValue({
      ciphertext: FAKE_CIPHERTEXT,
      sharedSecret: FAKE_SHARED_SECRET,
    });

    const args = { name: "My Project", region: "us-east-1" };
    const result = await interceptor.transformRequest("pqdb_create_project", args);

    expect(mockEncapsulate).toHaveBeenCalledOnce();
    expect(result.name).toBe("My Project");
    expect(result.region).toBe("us-east-1");
    expect(typeof result.wrapped_encryption_key).toBe("string");
    // The shared secret should NOT be stored yet (only after response confirms success)
    // but the pending secret should be tracked internally
  });
});

// ── transformRequest: pqdb_select_project ─────────────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_select_project", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("passes through args unchanged (decapsulation happens on response)", async () => {
    const args = { project_id: "proj-123" };
    const result = await interceptor.transformRequest("pqdb_select_project", args);
    expect(result).toEqual(args);
  });
});

// ── transformRequest: pqdb_natural_language_query ─────────────────────

describe("CryptoInterceptor.transformRequest — pqdb_natural_language_query", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("passes through NL query args unchanged (encryption happens server-side via query translation)", async () => {
    const args = { query: "show all users" };
    const result = await interceptor.transformRequest("pqdb_natural_language_query", args);
    expect(result).toEqual(args);
  });
});

// ── transformRequest: non-crypto tool ─────────────────────────────────

describe("CryptoInterceptor.transformRequest — non-crypto tool", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("returns args unchanged for non-crypto tools", async () => {
    const args = { project_id: "proj-123" };
    const result = await interceptor.transformRequest("pqdb_list_projects", args);
    expect(result).toEqual(args);
  });
});

// ── transformResponse: pqdb_query_rows ────────────────────────────────

describe("CryptoInterceptor.transformResponse — pqdb_query_rows", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
        ssn: { type: "text", sensitivity: "private" },
      },
    });
  });

  it("decrypts _encrypted columns in response data", async () => {
    const responseContent = JSON.stringify({
      data: [
        { id: "1", email_encrypted: "enc-bytes", ssn_encrypted: "enc-bytes2" },
      ],
      error: null,
    });

    const decryptedRows = [
      { id: "1", email: "alice@example.com", ssn: "123-45-6789" },
    ];
    mockTransformSelectResponse.mockResolvedValue(decryptedRows);

    // Need introspection for schema
    mockIntrospectionResponse();

    const result = await interceptor.transformResponse(
      "pqdb_query_rows",
      {
        content: [{ type: "text", text: responseContent }],
      },
      { table: "users" },
    );

    expect(mockTransformSelectResponse).toHaveBeenCalledOnce();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.data).toEqual(decryptedRows);
  });
});

// ── transformResponse: pqdb_select_project ────────────────────────────

describe("CryptoInterceptor.transformResponse — pqdb_select_project", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("decapsulates wrapped key and stores shared secret", async () => {
    mockDecapsulate.mockResolvedValue(FAKE_SHARED_SECRET);

    const responseContent = JSON.stringify({
      data: {
        project: {
          id: "proj-123",
          name: "Test Project",
          wrapped_encryption_key: Buffer.from(FAKE_CIPHERTEXT).toString("base64"),
        },
        encryption_active: false,
      },
      error: null,
    });

    const result = await interceptor.transformResponse(
      "pqdb_select_project",
      {
        content: [{ type: "text", text: responseContent }],
      },
      {},
    );

    expect(mockDecapsulate).toHaveBeenCalledOnce();
    expect(interceptor.hasSharedSecret()).toBe(true);

    // Response should indicate encryption is now active
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.data.encryption_active).toBe(true);
  });

  it("handles project without wrapped key gracefully", async () => {
    const responseContent = JSON.stringify({
      data: {
        project: {
          id: "proj-456",
          name: "Plain Project",
        },
        encryption_active: false,
      },
      error: null,
    });

    const result = await interceptor.transformResponse(
      "pqdb_select_project",
      {
        content: [{ type: "text", text: responseContent }],
      },
      {},
    );

    expect(mockDecapsulate).not.toHaveBeenCalled();
    expect(interceptor.hasSharedSecret()).toBe(false);
  });
});

// ── transformResponse: pqdb_create_project ────────────────────────────

describe("CryptoInterceptor.transformResponse — pqdb_create_project", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("commits pending shared secret after successful create", async () => {
    // First: trigger transformRequest to set up the pending secret
    mockFetchOk({ public_key: Buffer.from(FAKE_PUBLIC_KEY).toString("base64") });
    mockEncapsulate.mockResolvedValue({
      ciphertext: FAKE_CIPHERTEXT,
      sharedSecret: FAKE_SHARED_SECRET,
    });

    await interceptor.transformRequest("pqdb_create_project", { name: "New Project" });

    // Now transform the response
    const responseContent = JSON.stringify({
      data: {
        project: { id: "proj-new", name: "New Project" },
        encryption_active: true,
      },
      error: null,
    });

    await interceptor.transformResponse(
      "pqdb_create_project",
      {
        content: [{ type: "text", text: responseContent }],
      },
      {},
    );

    expect(interceptor.hasSharedSecret()).toBe(true);
  });

  it("does not commit secret if response is an error", async () => {
    // Trigger transformRequest
    mockFetchOk({ public_key: Buffer.from(FAKE_PUBLIC_KEY).toString("base64") });
    mockEncapsulate.mockResolvedValue({
      ciphertext: FAKE_CIPHERTEXT,
      sharedSecret: FAKE_SHARED_SECRET,
    });

    await interceptor.transformRequest("pqdb_create_project", { name: "New Project" });

    const responseContent = JSON.stringify({
      data: null,
      error: "Project creation failed",
    });

    await interceptor.transformResponse(
      "pqdb_create_project",
      {
        content: [{ type: "text", text: responseContent }],
        isError: true,
      },
      {},
    );

    expect(interceptor.hasSharedSecret()).toBe(false);
  });
});

// ── transformResponse: pqdb_natural_language_query ────────────────────

describe("CryptoInterceptor.transformResponse — pqdb_natural_language_query", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
      },
    });
  });

  it("decrypts _encrypted columns in NL query results", async () => {
    const responseContent = JSON.stringify({
      data: [
        { id: "1", email_encrypted: "enc-bytes" },
      ],
      error: null,
      translated_query: {
        table: "users",
        columns: ["*"],
        filters: [],
      },
    });

    const decryptedRows = [{ id: "1", email: "alice@example.com" }];
    mockTransformSelectResponse.mockResolvedValue(decryptedRows);

    // Introspection for schema
    mockIntrospectionResponse();

    const result = await interceptor.transformResponse(
      "pqdb_natural_language_query",
      {
        content: [{ type: "text", text: responseContent }],
      },
      {},
    );

    expect(mockTransformSelectResponse).toHaveBeenCalledOnce();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.data).toEqual(decryptedRows);
  });
});

// ── transformResponse: non-crypto tool ────────────────────────────────

describe("CryptoInterceptor.transformResponse — non-crypto tool", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
  });

  it("returns result unchanged for non-crypto tools", async () => {
    const result = {
      content: [{ type: "text", text: '{"data": [], "error": null}' }],
    };

    const output = await interceptor.transformResponse(
      "pqdb_list_projects",
      result,
      {},
    );

    expect(output).toEqual(result);
  });
});

// ── Schema caching ────────────────────────────────────────────────────

describe("CryptoInterceptor schema caching", () => {
  let interceptor: CryptoInterceptor;

  beforeEach(() => {
    vi.resetAllMocks();
    interceptor = createInterceptor();
    interceptor.setSharedSecret(FAKE_SHARED_SECRET);
    mockDeriveKeyPair.mockResolvedValue(FAKE_KEY_PAIR);
    mockDefineTableSchema.mockReturnValue({
      name: "users",
      columns: {
        id: { type: "uuid", sensitivity: "plain" },
        email: { type: "text", sensitivity: "searchable" },
      },
    });
  });

  it("caches schema and does not re-fetch within TTL", async () => {
    mockIntrospectionResponse();
    mockHmacKeyResponse();
    mockTransformFilters.mockReturnValue([]);

    const args = {
      table: "users",
      filters: [{ column: "email", op: "eq", value: "test@test.com" }],
    };

    await interceptor.transformRequest("pqdb_query_rows", args);

    // Second call should use cache — only HMAC key fetch, no introspection
    mockHmacKeyResponse();
    mockTransformFilters.mockReturnValue([]);

    await interceptor.transformRequest("pqdb_query_rows", args);

    // fetch should have been called:
    // 1st call: introspection + hmac
    // 2nd call: hmac only (schema cached)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
