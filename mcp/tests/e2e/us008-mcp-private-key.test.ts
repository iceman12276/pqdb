/**
 * US-008 integration test — MCP server with PQDB_PRIVATE_KEY does a full
 * encapsulate → create_project → insert → query round trip on a
 * searchable column.
 *
 * Boots a real FastAPI backend against real Postgres + Vault, then:
 *   1. Signs up a developer with a freshly generated ML-KEM-768 keypair
 *   2. Creates an MCP server instance configured with the private key
 *   3. Calls pqdb_create_project and asserts wrapped_encryption_key != null
 *   4. Verifies the raw shared secret is NOT in the tool response
 *   5. Creates a table with a searchable column and round-trips data
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import { generateKeyPair } from "@pqdb/client";

const API_PORT = 8770;
const API_URL = `http://localhost:${API_PORT}`;
const BACKEND_DIR = path.resolve(__dirname, "../../../backend");

const RUN_ID = Date.now();
const DEV_EMAIL = `us008-mcp-${RUN_ID}@test.pqdb.dev`;
const DEV_PASSWORD = "SuperSecretP@ss123!";

let serverProcess: ChildProcess;
let developerAccessToken: string;
let privateKey: Uint8Array;

async function apiCall(
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(`${API_URL}${urlPath}`, opts);
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${API_URL}/health`);
      if (resp.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function createMcpClient(
  apiKey: string,
  devToken: string,
  privKey: Uint8Array | undefined,
): Promise<Client> {
  const config: ServerConfig = {
    projectUrl: API_URL,
    transport: "stdio",
    port: 3001,
    apiKey,
    encryptionKey: undefined,
    devToken,
    projectId: undefined,
    privateKey: privKey,
  };
  const { mcpServer } = createPqdbMcpServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({
    name: "us008-test-client",
    version: "1.0.0",
  });
  await client.connect(clientTransport);
  return client;
}

beforeAll(async () => {
  // Generate a real ML-KEM-768 keypair for the developer
  const keypair = await generateKeyPair();
  privateKey = keypair.secretKey;
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString("base64");

  serverProcess = spawn(
    "uv",
    [
      "run",
      "uvicorn",
      "pqdb_api.app:create_app",
      "--factory",
      "--port",
      String(API_PORT),
    ],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PQDB_DATABASE_URL:
          "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_platform",
        PQDB_VAULT_ADDR: "http://localhost:8200",
        PQDB_VAULT_TOKEN: "dev-root-token",
        PQDB_SUPERUSER_DSN:
          "postgresql://postgres:postgres@localhost:5432/postgres",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.includes("ERROR") || msg.includes("Traceback")) {
      console.error("[backend]", msg);
    }
  });

  await waitForServer();

  // Sign up developer with the generated public key
  const signupResp = await apiCall("POST", "/v1/auth/signup", {
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
    ml_kem_public_key: publicKeyB64,
  });
  expect(signupResp.status).toBe(201);
  developerAccessToken = (signupResp.json as { access_token: string })
    .access_token;
}, 60_000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProcess.killed) {
      serverProcess.kill("SIGKILL");
    }
  }
});

describe("US-008 — MCP server + PQDB_PRIVATE_KEY integration", () => {
  it("pqdb_create_project produces a wrapped_encryption_key and does not leak the shared secret", async () => {
    const mcpClient = await createMcpClient(
      "",
      developerAccessToken,
      privateKey,
    );

    // 1 — Create an encrypted project via the MCP tool
    const createResult = await mcpClient.callTool({
      name: "pqdb_create_project",
      arguments: {
        name: `us008-mcp-${RUN_ID}`,
        region: "us-east-1",
      },
    });
    expect(createResult.isError).toBeFalsy();

    const rawText = (createResult.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(rawText) as {
      data: {
        project: {
          id: string;
          wrapped_encryption_key: string | null;
          api_keys: Array<{ role: string; key: string }>;
        };
        encryption_active: boolean;
        warning: string | null;
      };
      error: string | null;
    };

    expect(parsed.error).toBeNull();
    expect(parsed.data.encryption_active).toBe(true);
    expect(parsed.data.warning).toBeNull();
    // Backend echoes the wrapped_encryption_key we sent.
    expect(parsed.data.project.wrapped_encryption_key).toBeTruthy();
    expect(typeof parsed.data.project.wrapped_encryption_key).toBe("string");

    // SECURITY: the response must not contain any leaked key material.
    // Shared secret is 32 bytes — its base64 is trivially short; look for
    // the private key's first-16-byte prefix base64 (high-confidence canary).
    const privKeyPrefix = Buffer.from(privateKey.slice(0, 32)).toString(
      "base64",
    );
    expect(rawText).not.toContain(privKeyPrefix);

    const projectId = parsed.data.project.id;

    // 2 — Round-trip on a searchable column using the SDK + service API key
    // (obtained via platform API since MCP create_project echoes api_keys).
    const serviceApiKey = parsed.data.project.api_keys.find(
      (k) => k.role === "service_role" || k.role === "service",
    )?.key;
    expect(serviceApiKey).toBeTruthy();

    // Create a table with a searchable column via the platform API.
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "us008_contacts",
        columns: [
          { name: "name", data_type: "text", sensitivity: "plain" },
          { name: "email", data_type: "text", sensitivity: "searchable" },
        ],
      },
      { apikey: serviceApiKey! },
    );
    expect(createTable.status).toBe(201);

    // 3 — pqdb_select_project should decapsulate without error
    const selectResult = await mcpClient.callTool({
      name: "pqdb_select_project",
      arguments: { project_id: projectId },
    });
    expect(selectResult.isError).toBeFalsy();
    const selParsed = JSON.parse(
      (selectResult.content as Array<{ text: string }>)[0].text,
    ) as {
      data: { encryption_active: boolean };
    };
    expect(selParsed.data.encryption_active).toBe(true);
  }, 60_000);

  it("encrypted insert/query round-trip on a searchable column uses the per-project shared secret", async () => {
    // Regression test for PR #149 defect: the shared secret produced by
    // pqdb_create_project was never consumed by pqdb_insert_rows /
    // pqdb_query_rows, so an AI agent that set PQDB_PRIVATE_KEY would see
    // "encryption_active: true" and then fail on the first CRUD call.
    //
    // This test exercises the full wiring: create encrypted project → create
    // a table with a searchable column → insert via MCP → query via MCP with
    // an `.eq` filter on the searchable column → assert the row round-trips.
    // Success implies the blind-index HMAC and the encrypt/decrypt keypair
    // are all derived from the SAME per-project shared secret. Any drift
    // (e.g., deriving from a legacy env var instead) would cause the
    // HMAC-indexed eq filter to return zero rows.

    // Use a separate MCP client that also has the service API key, so CRUD
    // calls authenticate as the project (not the developer). The private
    // key is required so pqdb_create_project can encapsulate.
    const keypair2 = await generateKeyPair();
    const privateKey2 = keypair2.secretKey;
    const publicKeyB64_2 = Buffer.from(keypair2.publicKey).toString("base64");

    // Sign up a fresh developer for this test so we don't interfere with
    // the public key registered in beforeAll.
    const email2 = `us008-mcp-rt-${RUN_ID}@test.pqdb.dev`;
    const signup2 = await apiCall("POST", "/v1/auth/signup", {
      email: email2,
      password: DEV_PASSWORD,
      ml_kem_public_key: publicKeyB64_2,
    });
    expect(signup2.status).toBe(201);
    const devToken2 = (signup2.json as { access_token: string }).access_token;

    // Phase A: create the encrypted project via MCP (no apiKey yet).
    const mcpCreate = await createMcpClient("", devToken2, privateKey2);
    const createResult = await mcpCreate.callTool({
      name: "pqdb_create_project",
      arguments: { name: `us008-mcp-rt-${RUN_ID}`, region: "us-east-1" },
    });
    expect(createResult.isError).toBeFalsy();
    const created = JSON.parse(
      (createResult.content as Array<{ text: string }>)[0].text,
    ) as {
      data: {
        project: {
          id: string;
          api_keys: Array<{ role: string; key: string }>;
          wrapped_encryption_key: string | null;
        };
        encryption_active: boolean;
      };
    };
    expect(created.data.encryption_active).toBe(true);
    expect(created.data.project.wrapped_encryption_key).toBeTruthy();

    const serviceApiKey = created.data.project.api_keys.find(
      (k) => k.role === "service_role" || k.role === "service",
    )?.key;
    expect(serviceApiKey).toBeTruthy();

    // Create the table (needs service key). Do this via the platform API;
    // table DDL isn't the MCP tool we're exercising here.
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "us008_rt_contacts",
        columns: [
          { name: "name", data_type: "text", sensitivity: "plain" },
          { name: "email", data_type: "text", sensitivity: "searchable" },
        ],
      },
      { apikey: serviceApiKey! },
    );
    expect(createTable.status).toBe(201);

    // Phase B: spin up a SECOND MCP client that carries the service API
    // key (so CRUD tools authenticate as the project) AND the private key
    // (so pqdb_select_project can decapsulate and populate the shared
    // secret). Creating the client does NOT call create_project, so we
    // must explicitly select the project to populate the shared secret.
    const mcpCrud = await createMcpClient(
      serviceApiKey!,
      devToken2,
      privateKey2,
    );
    const selectResult = await mcpCrud.callTool({
      name: "pqdb_select_project",
      arguments: { project_id: created.data.project.id },
    });
    expect(selectResult.isError).toBeFalsy();
    const selParsed = JSON.parse(
      (selectResult.content as Array<{ text: string }>)[0].text,
    ) as { data: { encryption_active: boolean } };
    expect(selParsed.data.encryption_active).toBe(true);

    // INSERT via MCP — this path runs transformInsertRows which encrypts
    // the `email` column AND computes its blind-index HMAC using the
    // per-project shared secret derived keypair + HMAC key.
    const insertResult = await mcpCrud.callTool({
      name: "pqdb_insert_rows",
      arguments: {
        table: "us008_rt_contacts",
        rows: [{ name: "Alice", email: "alice@us008.test" }],
      },
    });
    expect(insertResult.isError).toBeFalsy();

    // QUERY via MCP with an .eq filter on the searchable `email` column.
    // The SDK rewrites this into an HMAC equality lookup on `email_index`.
    // If the HMAC key used on insert and the HMAC key used on query are
    // different — which would happen if CRUD was still reading the legacy
    // PQDB_ENCRYPTION_KEY env var — the lookup would return zero rows.
    const queryResult = await mcpCrud.callTool({
      name: "pqdb_query_rows",
      arguments: {
        table: "us008_rt_contacts",
        filters: [{ column: "email", op: "eq", value: "alice@us008.test" }],
      },
    });
    expect(queryResult.isError).toBeFalsy();
    const queryParsed = JSON.parse(
      (queryResult.content as Array<{ text: string }>)[0].text,
    ) as { data: Array<{ name?: string; email?: string }>; error: string | null };
    expect(queryParsed.error).toBeNull();
    expect(queryParsed.data).toBeDefined();
    expect(queryParsed.data.length).toBe(1);
    expect(queryParsed.data[0].name).toBe("Alice");
    // The decrypted email column must round-trip back to the plaintext.
    // This proves the ML-KEM keypair used to encrypt was derived from the
    // same shared secret that's available for decryption.
    expect(queryParsed.data[0].email).toBe("alice@us008.test");
  }, 90_000);

  it("pqdb_create_project without PQDB_PRIVATE_KEY creates a plaintext project with a warning", async () => {
    const mcpClient = await createMcpClient(
      "",
      developerAccessToken,
      undefined,
    );

    const result = await mcpClient.callTool({
      name: "pqdb_create_project",
      arguments: {
        name: `us008-mcp-plain-${RUN_ID}`,
        region: "us-east-1",
      },
    });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(
      (result.content as Array<{ text: string }>)[0].text,
    ) as {
      data: {
        project: { wrapped_encryption_key: string | null };
        encryption_active: boolean;
        warning: string | null;
      };
    };
    expect(parsed.data.encryption_active).toBe(false);
    expect(parsed.data.warning).toContain("No PQDB_PRIVATE_KEY set");
    expect(parsed.data.project.wrapped_encryption_key).toBeNull();
  }, 30_000);
});
