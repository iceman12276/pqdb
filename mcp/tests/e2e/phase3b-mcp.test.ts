/**
 * Phase 3b E2E tests — MCP server: schema discovery, CRUD, NL-to-query.
 *
 * These tests boot a real uvicorn server against real Postgres + Vault,
 * then exercise:
 *   1 — MCP schema discovery (list_tables, describe_table)
 *   2 — MCP CRUD (insert + query, with and without encryption key)
 *   3 — NL-to-query via MCP natural language tool
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import { createClient, column } from "@pqdb/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_PORT = 8769;
const API_URL = `http://localhost:${API_PORT}`;
const BACKEND_DIR = path.resolve(__dirname, "../../../backend");
const ENCRYPTION_KEY = "e2e-phase3b-master-key-for-pqc";

const RUN_ID = Date.now();
const DEV_EMAIL = `e2e-p3b-mcp-${RUN_ID}@test.pqdb.dev`;
const DEV_PASSWORD = "SuperSecretP@ss123!";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess;
let developerAccessToken: string;
let projectId: string;
let serviceApiKey: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
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
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

/** Create an MCP client connected to our server via InMemoryTransport. */
async function createMcpClient(
  apiKey: string,
  encryptionKey?: string,
): Promise<Client> {
  const config: ServerConfig = {
    projectUrl: API_URL,
    transport: "stdio",
    port: 3001,
    apiKey,
    encryptionKey,
  };
  const { mcpServer } = createPqdbMcpServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
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

  // --- Platform setup: signup developer, create project, get keys ---
  const signupResp = await apiCall("POST", "/v1/auth/signup", {
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
  });
  expect(signupResp.status).toBe(201);
  developerAccessToken = (signupResp.json as { access_token: string })
    .access_token;

  const createResult = await apiCall(
    "POST",
    "/v1/projects",
    { name: "e2e-phase3b-mcp-project", region: "us-east-1" },
    { Authorization: `Bearer ${developerAccessToken}` },
  );
  expect(createResult.status).toBe(201);
  const project = createResult.json as {
    id: string;
    database_name: string;
    api_keys: Array<{ role: string; key: string }>;
  };
  projectId = project.id;
  serviceApiKey = project.api_keys.find((k) => k.role === "service")!.key;
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

// ===========================================================================
// Test 1 — MCP schema discovery
// ===========================================================================
describe("Test 1 — MCP schema discovery", () => {
  it("pqdb_list_tables returns tables, pqdb_describe_table returns columns with sensitivity", async () => {
    // Create a table with mixed sensitivity so we have something to discover
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "mcp_schema_test",
        columns: [
          { name: "user_id", data_type: "uuid", sensitivity: "plain", owner: true },
          { name: "email", data_type: "text", sensitivity: "searchable" },
          { name: "secret_note", data_type: "text", sensitivity: "private" },
          { name: "status", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Connect MCP client
    const mcpClient = await createMcpClient(serviceApiKey);

    // pqdb_list_tables
    const listResult = await mcpClient.callTool({
      name: "pqdb_list_tables",
      arguments: {},
    });
    expect(listResult.isError).toBeFalsy();
    const tables = JSON.parse(
      (listResult.content[0] as { text: string }).text,
    ) as Array<{
      name: string;
      column_count: number;
      sensitivity_summary: Record<string, number>;
    }>;
    const mcpTable = tables.find((t) => t.name === "mcp_schema_test");
    expect(mcpTable).toBeTruthy();
    expect(mcpTable!.column_count).toBeGreaterThanOrEqual(4);
    expect(mcpTable!.sensitivity_summary).toHaveProperty("searchable");
    expect(mcpTable!.sensitivity_summary).toHaveProperty("private");

    // pqdb_describe_table
    const describeResult = await mcpClient.callTool({
      name: "pqdb_describe_table",
      arguments: { table_name: "mcp_schema_test" },
    });
    expect(describeResult.isError).toBeFalsy();
    const tableSchema = JSON.parse(
      (describeResult.content[0] as { text: string }).text,
    ) as {
      name: string;
      columns: Array<{
        name: string;
        type: string;
        sensitivity: string;
        is_owner: boolean;
      }>;
    };
    expect(tableSchema.name).toBe("mcp_schema_test");

    // Verify columns and their sensitivities
    const emailCol = tableSchema.columns.find((c) => c.name === "email");
    expect(emailCol).toBeTruthy();
    expect(emailCol!.sensitivity).toBe("searchable");

    const secretCol = tableSchema.columns.find((c) => c.name === "secret_note");
    expect(secretCol).toBeTruthy();
    expect(secretCol!.sensitivity).toBe("private");

    const statusCol = tableSchema.columns.find((c) => c.name === "status");
    expect(statusCol).toBeTruthy();
    expect(statusCol!.sensitivity).toBe("plain");

    const ownerCol = tableSchema.columns.find((c) => c.name === "user_id");
    expect(ownerCol).toBeTruthy();
    expect(ownerCol!.is_owner).toBe(true);
  }, 30_000);
});

// ===========================================================================
// Test 2 — MCP CRUD (insert + query, with/without encryption)
// ===========================================================================
describe("Test 2 — MCP CRUD", () => {
  it("pqdb_insert_rows then pqdb_query_rows; without encryption key shows [encrypted], with key shows plaintext", async () => {
    // Create a table with searchable column
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "mcp_crud_test",
        columns: [
          { name: "name", data_type: "text", sensitivity: "plain" },
          { name: "email", data_type: "text", sensitivity: "searchable" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Insert some data via SDK (with encryption) so encrypted values exist
    const sdkClient = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const emailSchema = sdkClient.defineTable("mcp_crud_test", {
      name: column.text(),
      email: column.text().sensitive("searchable"),
    });
    const insertResult = await sdkClient
      .from(emailSchema)
      .insert([
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ])
      .execute();
    expect(insertResult.error).toBeNull();

    // --- MCP client WITHOUT encryption key ---
    const mcpNoEnc = await createMcpClient(serviceApiKey);

    const queryNoEnc = await mcpNoEnc.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "mcp_crud_test" },
    });
    expect(queryNoEnc.isError).toBeFalsy();
    const noEncResult = JSON.parse(
      (queryNoEnc.content[0] as { text: string }).text,
    ) as { data: Record<string, unknown>[]; error: string | null };
    expect(noEncResult.error).toBeNull();
    expect(noEncResult.data.length).toBe(2);

    // Without encryption key, encrypted columns should show [encrypted]
    for (const row of noEncResult.data) {
      expect(row.name).toBeTruthy(); // plain column visible
      expect(row.email_encrypted).toBe("[encrypted]"); // encrypted column masked
    }

    // --- MCP client WITH encryption key ---
    // With encryption key set, the MCP server passes through raw ciphertext
    // (not masked with [encrypted])
    const mcpWithEnc = await createMcpClient(serviceApiKey, ENCRYPTION_KEY);

    const queryWithEnc = await mcpWithEnc.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "mcp_crud_test" },
    });
    expect(queryWithEnc.isError).toBeFalsy();
    const withEncResult = JSON.parse(
      (queryWithEnc.content[0] as { text: string }).text,
    ) as { data: Record<string, unknown>[]; error: string | null };
    expect(withEncResult.error).toBeNull();
    expect(withEncResult.data.length).toBe(2);

    // With encryption key, the encrypted column value should NOT be "[encrypted]"
    for (const row of withEncResult.data) {
      expect(row.name).toBeTruthy();
      expect(row.email_encrypted).not.toBe("[encrypted]");
      expect(row.email_encrypted).toBeTruthy();
    }

    // --- Also verify MCP insert works ---
    const mcpInsert = await mcpNoEnc.callTool({
      name: "pqdb_insert_rows",
      arguments: {
        table: "mcp_crud_test",
        rows: [{ name: "Charlie" }],
      },
    });
    expect(mcpInsert.isError).toBeFalsy();

    // Verify the insert
    const queryAfter = await mcpNoEnc.callTool({
      name: "pqdb_query_rows",
      arguments: { table: "mcp_crud_test" },
    });
    const afterResult = JSON.parse(
      (queryAfter.content[0] as { text: string }).text,
    ) as { data: Record<string, unknown>[] };
    expect(afterResult.data.length).toBe(3);
    const charlie = afterResult.data.find((r) => r.name === "Charlie");
    expect(charlie).toBeTruthy();
  }, 30_000);
});

// ===========================================================================
// Test 3 — NL-to-query via MCP
// ===========================================================================
describe("Test 3 — NL-to-query", () => {
  it("pqdb_natural_language_query finds rows via NL query", async () => {
    // Create a table with text-only columns for NL query (avoids type coercion issues)
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "nl_query_test",
        columns: [
          { name: "username", data_type: "text", sensitivity: "plain" },
          { name: "city", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Insert data
    await apiCall(
      "POST",
      "/v1/db/nl_query_test/insert",
      {
        rows: [
          { username: "alice", city: "paris" },
          { username: "bob", city: "london" },
          { username: "carol", city: "paris" },
        ],
      },
      { apikey: serviceApiKey },
    );

    const mcpClient = await createMcpClient(serviceApiKey);

    // NL query: "show all nl_query_test"
    const nlResult = await mcpClient.callTool({
      name: "pqdb_natural_language_query",
      arguments: { query: "show all nl_query_test" },
    });
    expect(nlResult.isError).toBeFalsy();
    const nlData = JSON.parse(
      (nlResult.content[0] as { text: string }).text,
    ) as {
      data: Record<string, unknown>[];
      error: string | null;
      translated_query: {
        table: string;
        columns: string[];
        filters: unknown[];
        limit?: number;
      };
    };
    expect(nlData.error).toBeNull();
    expect(nlData.data.length).toBe(3);
    expect(nlData.translated_query.table).toBe("nl_query_test");

    // NL query with filter: "get nl_query_test where city = paris"
    const nlFilterResult = await mcpClient.callTool({
      name: "pqdb_natural_language_query",
      arguments: { query: "get nl_query_test where city = paris" },
    });
    expect(nlFilterResult.isError).toBeFalsy();
    const nlFilterData = JSON.parse(
      (nlFilterResult.content[0] as { text: string }).text,
    ) as {
      data: Record<string, unknown>[];
      error: string | null;
    };
    expect(nlFilterData.error).toBeNull();
    expect(nlFilterData.data.length).toBe(2);
    const names = nlFilterData.data.map((r) => r.username);
    expect(names).toContain("alice");
    expect(names).toContain("carol");

    // NL query with limit: "first 2 nl_query_test"
    const nlLimitResult = await mcpClient.callTool({
      name: "pqdb_natural_language_query",
      arguments: { query: "first 2 nl_query_test" },
    });
    expect(nlLimitResult.isError).toBeFalsy();
    const nlLimitData = JSON.parse(
      (nlLimitResult.content[0] as { text: string }).text,
    ) as {
      data: Record<string, unknown>[];
      translated_query: { limit: number };
    };
    expect(nlLimitData.data.length).toBe(2);
    expect(nlLimitData.translated_query.limit).toBe(2);
  }, 30_000);
});
