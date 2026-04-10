/**
 * Unit tests for pqdb_select_project decapsulate flow (US-008).
 *
 * When selecting an existing project that has wrapped_encryption_key,
 * the MCP server should call decapsulate(wrapped_key, private_key)
 * and store the recovered shared secret in auth-state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import {
  clearCurrentPrivateKey,
  clearCurrentSharedSecret,
  getCurrentSharedSecret,
} from "../../src/auth-state.js";

const mockCiphertext = new Uint8Array(1088).fill(0xcc);
const mockSharedSecret = new Uint8Array(32).fill(0xee);

vi.mock("@pqdb/client", async () => {
  return {
    createClient: vi.fn(() => ({
      auth: {},
      defineTable: vi.fn(),
      from: vi.fn(),
      reindex: vi.fn(),
    })),
    encapsulate: vi.fn(async () => ({
      ciphertext: mockCiphertext,
      sharedSecret: mockSharedSecret,
    })),
    decapsulate: vi.fn(async (_ct: Uint8Array, _sk: Uint8Array) => mockSharedSecret),
  };
});

// Grab the mocked decapsulate after the mock is hoisted
import * as pqdbClient from "@pqdb/client";
const decapsulateMock = vi.mocked(pqdbClient.decapsulate);

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

function makePrivateKey(): Uint8Array {
  const key = new Uint8Array(2400);
  for (let i = 0; i < key.length; i++) key[i] = (i * 11) % 256;
  return key;
}

describe("pqdb_select_project with PQDB_PRIVATE_KEY (US-008)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCurrentPrivateKey();
    clearCurrentSharedSecret();
  });

  afterEach(() => {
    clearCurrentPrivateKey();
    clearCurrentSharedSecret();
  });

  it("calls decapsulate with the configured private key and the project's wrapped_encryption_key; stores shared secret", async () => {
    const privateKey = makePrivateKey();
    const client = await createTestClient({ privateKey });

    const wrappedKeyB64 = Buffer.from(mockCiphertext).toString("base64");

    mockFetchOk({
      id: "proj-abc",
      name: "My Project",
      status: "active",
      wrapped_encryption_key: wrappedKeyB64,
    });

    const result = await client.callTool({
      name: "pqdb_select_project",
      arguments: { project_id: "proj-abc" },
    });

    expect(result.isError).toBeFalsy();

    // decapsulate invoked with the wrapped key bytes + configured private key
    expect(decapsulateMock).toHaveBeenCalledTimes(1);
    const callArgs = decapsulateMock.mock.calls[0];
    expect(callArgs[0]).toBeInstanceOf(Uint8Array);
    expect(callArgs[0].length).toBe(mockCiphertext.length);
    expect(Buffer.from(callArgs[0]).toString("hex")).toBe(
      Buffer.from(mockCiphertext).toString("hex"),
    );
    expect(callArgs[1]).toBeInstanceOf(Uint8Array);
    expect(callArgs[1].length).toBe(2400);

    // Shared secret stored
    const stored = getCurrentSharedSecret();
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(stored!).toString("hex")).toBe(
      Buffer.from(mockSharedSecret).toString("hex"),
    );

    // SECURITY: shared secret must not appear in tool response
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain(Buffer.from(mockSharedSecret).toString("base64"));
    expect(text).not.toContain(Buffer.from(privateKey).toString("base64"));
  });

  it("skips decapsulate when the selected project has no wrapped_encryption_key", async () => {
    const privateKey = makePrivateKey();
    const client = await createTestClient({ privateKey });

    mockFetchOk({
      id: "proj-plain",
      name: "Plaintext",
      status: "active",
      // no wrapped_encryption_key
    });

    const result = await client.callTool({
      name: "pqdb_select_project",
      arguments: { project_id: "proj-plain" },
    });
    expect(result.isError).toBeFalsy();
    expect(decapsulateMock).not.toHaveBeenCalled();
    expect(getCurrentSharedSecret()).toBeUndefined();
  });

  it("skips decapsulate when no PQDB_PRIVATE_KEY is configured, even if project has wrapped key", async () => {
    const client = await createTestClient({ privateKey: undefined });

    mockFetchOk({
      id: "proj-abc",
      name: "Project",
      status: "active",
      wrapped_encryption_key: Buffer.from(mockCiphertext).toString("base64"),
    });

    const result = await client.callTool({
      name: "pqdb_select_project",
      arguments: { project_id: "proj-abc" },
    });
    expect(result.isError).toBeFalsy();
    expect(decapsulateMock).not.toHaveBeenCalled();
    expect(getCurrentSharedSecret()).toBeUndefined();
  });
});
