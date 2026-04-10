/**
 * Unit tests for pqdb_create_project with PQDB_PRIVATE_KEY (US-008).
 *
 * Covers:
 *   - With private key: fetches public key, calls encapsulate, sends
 *     wrapped_encryption_key in POST body, stores sharedSecret in auth-state
 *   - Without private key: plain project creation + warning in result
 *   - Never leaks raw private key or shared secret into tool response
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import {
  clearCurrentPrivateKey,
  clearCurrentSharedSecret,
  getCurrentPrivateKey,
  getCurrentSharedSecret,
  setCurrentPrivateKey,
} from "../../src/auth-state.js";

// ── Mocks ───────────────────────────────────────────────────────────────

// Mock encapsulate/decapsulate from @pqdb/client so we don't need real ML-KEM
// Signature matches sdk/src/crypto/pqc.ts:
//   encapsulate(publicKey) -> { ciphertext, sharedSecret }
//   decapsulate(ciphertext, secretKey) -> sharedSecret
const mockCiphertext = new Uint8Array(1088).fill(0xcc);
const mockSharedSecret = new Uint8Array(32).fill(0xdd);

vi.mock("@pqdb/client", async () => {
  return {
    createClient: vi.fn(() => ({
      auth: {},
      defineTable: vi.fn(),
      from: vi.fn(),
      reindex: vi.fn(),
    })),
    encapsulate: vi.fn(async (_publicKey: Uint8Array) => ({
      ciphertext: mockCiphertext,
      sharedSecret: mockSharedSecret,
    })),
    decapsulate: vi.fn(async (_ct: Uint8Array, _sk: Uint8Array) => {
      return mockSharedSecret;
    }),
  };
});

// Global fetch mock
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    projectUrl: "http://localhost:8000",
    transport: "stdio",
    port: 3001,
    apiKey: "",
    encryptionKey: undefined,
    devToken: "dev-jwt-token-123",
    projectId: undefined,
    privateKey: undefined,
    ...overrides,
  };
}

async function createTestClient(
  overrides: Partial<ServerConfig> = {},
): Promise<Client> {
  const { mcpServer } = createPqdbMcpServer(makeConfig(overrides));
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
    statusText: "OK",
    json: async () => data,
  });
}

// A valid-shaped ML-KEM-768 private key (2400 bytes of distinct-ish bytes)
function makePrivateKey(): Uint8Array {
  const key = new Uint8Array(2400);
  for (let i = 0; i < key.length; i++) {
    key[i] = (i * 7) % 256;
  }
  return key;
}

// Public key base64 (value doesn't matter because encapsulate is mocked)
const PUBLIC_KEY_B64 = Buffer.from(new Uint8Array(1184).fill(0x11)).toString(
  "base64",
);

describe("pqdb_create_project with PQDB_PRIVATE_KEY (US-008)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCurrentPrivateKey();
    clearCurrentSharedSecret();
  });

  afterEach(() => {
    clearCurrentPrivateKey();
    clearCurrentSharedSecret();
  });

  it("fetches developer public key, calls encapsulate, sends wrapped_encryption_key in POST body, stores shared secret", async () => {
    const privateKey = makePrivateKey();
    const client = await createTestClient({ privateKey });

    // 1st fetch: GET /v1/auth/me/public-key
    mockFetchOk({ public_key: PUBLIC_KEY_B64 });
    // 2nd fetch: POST /v1/projects (echoes wrapped_encryption_key)
    const createdProject = {
      id: "proj-new-1",
      name: "Encrypted Project",
      region: "us-east-1",
      status: "active",
      database_name: "pqdb_project_xyz",
      wrapped_encryption_key: Buffer.from(mockCiphertext).toString("base64"),
    };
    mockFetchOk(createdProject);

    const result = await client.callTool({
      name: "pqdb_create_project",
      arguments: { name: "Encrypted Project", region: "us-east-1" },
    });

    // Two fetch calls total
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: GET public key with dev JWT
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[0]).toBe("http://localhost:8000/v1/auth/me/public-key");
    expect(firstCall[1]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: "Bearer dev-jwt-token-123",
      }),
    });

    // Second call: POST /v1/projects with base64 wrapped_encryption_key
    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[0]).toBe("http://localhost:8000/v1/projects");
    expect(secondCall[1].method).toBe("POST");
    const body = JSON.parse(secondCall[1].body as string);
    expect(body.name).toBe("Encrypted Project");
    expect(body.region).toBe("us-east-1");
    expect(body.wrapped_encryption_key).toBe(
      Buffer.from(mockCiphertext).toString("base64"),
    );

    // Tool result — success, NO raw shared secret leaked
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;

    // SECURITY: assert the raw shared secret (base64) is NOT in the response
    const sharedSecretB64 = Buffer.from(mockSharedSecret).toString("base64");
    expect(text).not.toContain(sharedSecretB64);

    // SECURITY: the raw private key bytes must not leak either
    const privateKeyB64 = Buffer.from(privateKey).toString("base64");
    expect(text).not.toContain(privateKeyB64);

    // Shared secret is stored in auth-state for subsequent CRUD
    const stored = getCurrentSharedSecret();
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(stored!.length).toBe(32);
    expect(Buffer.from(stored!).toString("hex")).toBe(
      Buffer.from(mockSharedSecret).toString("hex"),
    );
  });

  it("without PQDB_PRIVATE_KEY: creates plaintext project and emits a warning in the tool result", async () => {
    const client = await createTestClient({ privateKey: undefined });

    // Only one fetch: POST /v1/projects (no public-key fetch because no key)
    mockFetchOk({
      id: "proj-plaintext-1",
      name: "Plaintext Project",
      region: "us-east-1",
      status: "active",
    });

    const result = await client.callTool({
      name: "pqdb_create_project",
      arguments: { name: "Plaintext Project" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("http://localhost:8000/v1/projects");
    const body = JSON.parse(call[1].body as string);
    expect(body.name).toBe("Plaintext Project");
    // No wrapped_encryption_key in plaintext path
    expect(body.wrapped_encryption_key).toBeUndefined();

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    // Warning is visible to the AI agent
    expect(text).toContain("No PQDB_PRIVATE_KEY set");
    expect(text.toLowerCase()).toContain("searchable");

    // No shared secret is stored in this path
    expect(getCurrentSharedSecret()).toBeUndefined();
  });

  it("fails gracefully when developer has no public key uploaded", async () => {
    const privateKey = makePrivateKey();
    const client = await createTestClient({ privateKey });

    // Public key endpoint returns null
    mockFetchOk({ public_key: null });

    const result = await client.callTool({
      name: "pqdb_create_project",
      arguments: { name: "NoKeyProject" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/public.key/i);
    // POST to /v1/projects should NOT have been made
    expect(
      mockFetch.mock.calls.find(
        (c) => c[0] === "http://localhost:8000/v1/projects",
      ),
    ).toBeUndefined();
    expect(getCurrentSharedSecret()).toBeUndefined();
  });

  it("sets the in-memory private key from config at server construction", async () => {
    const privateKey = makePrivateKey();
    await createTestClient({ privateKey });
    const stored = getCurrentPrivateKey();
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(stored!.length).toBe(2400);
  });
});
