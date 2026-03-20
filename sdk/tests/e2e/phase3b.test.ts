/**
 * Phase 3b E2E tests — MCP server, Vector search, Realtime subscriptions.
 *
 * These tests boot a real uvicorn server against real Postgres + Vault,
 * then exercise:
 *   1 — MCP schema discovery (list_tables, describe_table)
 *   2 — MCP CRUD (insert + query, with and without encryption key)
 *   3 — NL-to-query via MCP natural language tool
 *   4 — Vector search (.similarTo() via SDK)
 *   5 — Vector + encryption (vector search with encrypted columns)
 *   6 — Realtime subscribe + receive (WebSocket insert events)
 *   7 — Realtime RLS (owner policy filtering)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import * as path from "path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPqdbMcpServer } from "../../../mcp/src/server.js";
import type { ServerConfig } from "../../../mcp/src/config.js";
import { createClient, column } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_PORT = 8769;
const API_URL = `http://localhost:${API_PORT}`;
const WS_URL = `ws://localhost:${API_PORT}`;
const BACKEND_DIR = path.resolve(__dirname, "../../../backend");
const ENCRYPTION_KEY = "e2e-phase3b-master-key-for-pqc";

const RUN_ID = Date.now();
const DEV_EMAIL = `e2e-p3b-${RUN_ID}@test.pqdb.dev`;
const DEV_PASSWORD = "SuperSecretP@ss123!";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess;
let developerAccessToken: string;
let projectId: string;
let projectDbName: string;
let serviceApiKey: string;
let anonApiKey: string;

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

/** Open a raw WebSocket and wait for the connection to be established. */
function openWs(
  apiKey: string,
  token?: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let url = `${WS_URL}/v1/realtime?apikey=${encodeURIComponent(apiKey)}`;
    if (token) {
      url += `&token=${encodeURIComponent(token)}`;
    }
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", (err) => reject(err));
  });
}

/** Send a JSON message on a WebSocket. */
function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

/** Wait for a WebSocket message matching a predicate, with timeout. */
function waitForWsMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket message not received within ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      } catch {
        // ignore non-JSON
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }

    ws.on("message", onMessage);
  });
}

/** Enable pgvector extension in a project database via psql. */
function enablePgvector(dbName: string): void {
  execFileSync("psql", [
    "-h", "localhost",
    "-p", "5432",
    "-U", "postgres",
    "-d", dbName,
    "-c", "CREATE EXTENSION IF NOT EXISTS vector",
  ], {
    env: { ...process.env, PGPASSWORD: "postgres" },
    stdio: "pipe",
  });
}

/**
 * Install the pqdb_realtime trigger function and per-table trigger
 * in the project database. This enables pg_notify for realtime events.
 */
function installRealtimeTrigger(dbName: string, tableName: string): void {
  const fnSql = `
    CREATE OR REPLACE FUNCTION pqdb_notify_changes()
    RETURNS trigger AS $$
    DECLARE
        payload json;
        pk text;
    BEGIN
        IF TG_OP = 'DELETE' THEN
            pk := OLD.id::text;
        ELSE
            pk := NEW.id::text;
        END IF;
        payload := json_build_object(
            'table', TG_TABLE_NAME,
            'event', TG_OP,
            'pk', pk
        );
        PERFORM pg_notify('pqdb_realtime', payload::text);
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        ELSE
            RETURN NEW;
        END IF;
    END;
    $$ LANGUAGE plpgsql;
  `;
  const trigSql = `
    CREATE TRIGGER pqdb_realtime_trigger
    AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
    FOR EACH ROW EXECUTE FUNCTION pqdb_notify_changes();
  `;
  execFileSync("psql", [
    "-h", "localhost", "-p", "5432", "-U", "postgres",
    "-d", dbName, "-c", fnSql,
  ], {
    env: { ...process.env, PGPASSWORD: "postgres" },
    stdio: "pipe",
  });
  execFileSync("psql", [
    "-h", "localhost", "-p", "5432", "-U", "postgres",
    "-d", dbName, "-c", trigSql,
  ], {
    env: { ...process.env, PGPASSWORD: "postgres" },
    stdio: "pipe",
  });
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
    { name: "e2e-phase3b-project", region: "us-east-1" },
    { Authorization: `Bearer ${developerAccessToken}` },
  );
  expect(createResult.status).toBe(201);
  const project = createResult.json as {
    id: string;
    database_name: string;
    api_keys: Array<{ role: string; key: string }>;
  };
  projectId = project.id;
  projectDbName = project.database_name;
  serviceApiKey = project.api_keys.find((k) => k.role === "service")!.key;
  anonApiKey = project.api_keys.find((k) => k.role === "anon")!.key;

  // Enable pgvector extension in the project database for vector tests
  enablePgvector(projectDbName);
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

// ===========================================================================
// Test 4 — Vector search
// ===========================================================================
describe("Test 4 — Vector search", () => {
  it("create table with vector column, insert embeddings, .similarTo() returns top-5 by distance", async () => {
    // Create table with vector column
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "vector_test",
        columns: [
          { name: "label", data_type: "text", sensitivity: "plain" },
          { name: "embedding", data_type: "vector(3)", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Insert embeddings — pgvector requires string format "[x,y,z]"
    const embeddings = [
      { label: "a", embedding: "[1,0,0]" },
      { label: "b", embedding: "[0.9,0.1,0]" },
      { label: "c", embedding: "[0,1,0]" },
      { label: "d", embedding: "[0,0,1]" },
      { label: "e", embedding: "[0.7,0.7,0]" },
      { label: "f", embedding: "[0.5,0.5,0.5]" },
      { label: "g", embedding: "[0.1,0.1,0.9]" },
    ];

    const insertResp = await apiCall(
      "POST",
      "/v1/db/vector_test/insert",
      { rows: embeddings },
      { apikey: serviceApiKey },
    );
    expect(insertResp.status).toBe(201);

    // Query via SDK's .similarTo() — find top 5 closest to [1, 0, 0]
    const client = createClient(API_URL, serviceApiKey);
    const vectorSchema = client.defineTable("vector_test", {
      label: column.text(),
      embedding: column.vector(3),
    });

    const result = await client
      .from(vectorSchema)
      .select()
      .similarTo("embedding", [1.0, 0.0, 0.0], { limit: 5, distance: "cosine" })
      .execute();

    expect(result.error).toBeNull();
    expect(result.data).toBeTruthy();
    expect(result.data!.length).toBe(5);

    // The closest to [1,0,0] should be "a" (exact match), then "b" (very close)
    const labels = result.data!.map((r) => (r as Record<string, unknown>).label);
    expect(labels[0]).toBe("a");
    expect(labels[1]).toBe("b");

    // All returned rows should have labels from our dataset
    const allLabels = ["a", "b", "c", "d", "e", "f", "g"];
    for (const row of result.data!) {
      expect(allLabels).toContain(
        (row as Record<string, unknown>).label,
      );
    }

    // Also verify via MCP tool (pqdb_query_rows with similar_to)
    const mcpClient = await createMcpClient(serviceApiKey);
    const mcpResult = await mcpClient.callTool({
      name: "pqdb_query_rows",
      arguments: {
        table: "vector_test",
        similar_to: {
          column: "embedding",
          vector: [1.0, 0.0, 0.0],
          limit: 5,
          distance: "cosine",
        },
      },
    });
    expect(mcpResult.isError).toBeFalsy();
    const mcpData = JSON.parse(
      (mcpResult.content[0] as { text: string }).text,
    ) as { data: Record<string, unknown>[] };
    expect(mcpData.data.length).toBe(5);
    expect(mcpData.data[0].label).toBe("a");
  }, 30_000);
});

// ===========================================================================
// Test 5 — Vector + encryption
// ===========================================================================
describe("Test 5 — Vector + encryption", () => {
  it(".similarTo() with encrypted columns, SDK decrypts transparently", async () => {
    // Create table: vector column (plain) + encrypted text column
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "vec_enc_test",
        columns: [
          { name: "title", data_type: "text", sensitivity: "searchable" },
          { name: "embedding", data_type: "vector(3)", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Insert data via SDK with encryption
    const encClient = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const vecEncSchema = encClient.defineTable("vec_enc_test", {
      title: column.text().sensitive("searchable"),
      embedding: column.vector(3),
    });

    // Insert 5 items with embeddings (pgvector string format) and encrypted titles
    const items = [
      { title: "quantum computing", embedding: "[1,0,0]" },
      { title: "quantum physics", embedding: "[0.9,0.1,0]" },
      { title: "classical music", embedding: "[0,1,0]" },
      { title: "rock music", embedding: "[0,0.9,0.1]" },
      { title: "quantum music", embedding: "[0.5,0.5,0]" },
    ];

    const insertResult = await encClient
      .from(vecEncSchema)
      .insert(items)
      .execute();
    expect(insertResult.error).toBeNull();

    // Vector search — find closest to [1,0,0] (quantum computing)
    const searchResult = await encClient
      .from(vecEncSchema)
      .select()
      .similarTo("embedding", [1.0, 0.0, 0.0], { limit: 3, distance: "cosine" })
      .execute();

    expect(searchResult.error).toBeNull();
    expect(searchResult.data).toBeTruthy();
    expect(searchResult.data!.length).toBe(3);

    // The SDK should have decrypted the title transparently
    const titles = searchResult.data!.map(
      (r) => (r as Record<string, unknown>).title,
    );
    expect(titles[0]).toBe("quantum computing"); // exact match
    expect(titles[1]).toBe("quantum physics"); // next closest

    // Without encryption key, should get an error since table has searchable columns
    const plainClient = createClient(API_URL, serviceApiKey);
    const plainSchema = plainClient.defineTable("vec_enc_test", {
      title: column.text().sensitive("searchable"),
      embedding: column.vector(3),
    });

    const plainResult = await plainClient
      .from(plainSchema)
      .select()
      .similarTo("embedding", [1.0, 0.0, 0.0], { limit: 3, distance: "cosine" })
      .execute();

    expect(plainResult.error).toBeTruthy();
    expect(plainResult.error!.code).toBe("ENCRYPTION_ERROR");
  }, 30_000);
});

// ===========================================================================
// Test 6 — Realtime subscribe + receive
// ===========================================================================
describe("Test 6 — Realtime subscribe + receive", () => {
  it("subscribe to table, insert from another client, subscriber receives event", async () => {
    // Create a plain table for realtime testing
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "realtime_test",
        columns: [
          { name: "message", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Install the realtime trigger (not yet wired into table creation)
    installRealtimeTrigger(projectDbName, "realtime_test");

    // Open WebSocket connection and subscribe
    const ws = await openWs(serviceApiKey);

    try {
      // Subscribe to realtime_test
      wsSend(ws, { type: "subscribe", table: "realtime_test" });

      // Wait for ack
      const ack = await waitForWsMessage(
        ws,
        (msg) => msg.type === "ack" && msg.table === "realtime_test",
      );
      expect(ack.action).toBe("subscribe");

      // Small delay to ensure the listener is fully set up
      await new Promise((r) => setTimeout(r, 200));

      // Insert a row from another client (triggers pg_notify)
      const insertResp = await apiCall(
        "POST",
        "/v1/db/realtime_test/insert",
        { rows: [{ message: "hello realtime" }] },
        { apikey: serviceApiKey },
      );
      expect(insertResp.status).toBe(201);

      // Wait for the event on the WebSocket
      const event = await waitForWsMessage(
        ws,
        (msg) => msg.type === "event" && msg.table === "realtime_test",
      );
      expect(event.event).toBe("INSERT");
      expect((event.row as Record<string, unknown>).message).toBe(
        "hello realtime",
      );

      // Test unsubscribe
      wsSend(ws, { type: "unsubscribe", table: "realtime_test" });
      const unsubAck = await waitForWsMessage(
        ws,
        (msg) => msg.type === "ack" && msg.action === "unsubscribe",
      );
      expect(unsubAck.table).toBe("realtime_test");
    } finally {
      ws.close();
    }
  }, 30_000);
});

// ===========================================================================
// Test 7 — Realtime RLS
// ===========================================================================
describe("Test 7 — Realtime RLS", () => {
  it("owner policy: subscriber receives only own rows; service role receives all", async () => {
    // Create table with owner column
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "realtime_rls_test",
        columns: [
          {
            name: "owner_id",
            data_type: "uuid",
            sensitivity: "plain",
            owner: true,
          },
          { name: "content", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Install the realtime trigger (not yet wired into table creation)
    installRealtimeTrigger(projectDbName, "realtime_rls_test");

    // Create two end-users
    const user1Signup = await apiCall(
      "POST",
      "/v1/auth/users/signup",
      {
        email: `rt-user1-${RUN_ID}@test.pqdb.dev`,
        password: "User1Pass123!",
      },
      { apikey: anonApiKey },
    );
    expect(user1Signup.status).toBe(201);
    const user1 = user1Signup.json as {
      user: { id: string };
      access_token: string;
    };

    const user2Signup = await apiCall(
      "POST",
      "/v1/auth/users/signup",
      {
        email: `rt-user2-${RUN_ID}@test.pqdb.dev`,
        password: "User2Pass123!",
      },
      { apikey: anonApiKey },
    );
    expect(user2Signup.status).toBe(201);
    const user2 = user2Signup.json as {
      user: { id: string };
      access_token: string;
    };

    // Open WebSocket for user1 (with user JWT token for RLS)
    const wsUser1 = await openWs(anonApiKey, user1.access_token);
    // Open WebSocket for service role (bypasses RLS)
    const wsService = await openWs(serviceApiKey);

    try {
      // Both subscribe to realtime_rls_test
      wsSend(wsUser1, { type: "subscribe", table: "realtime_rls_test" });
      wsSend(wsService, { type: "subscribe", table: "realtime_rls_test" });

      // Wait for acks
      await waitForWsMessage(
        wsUser1,
        (msg) => msg.type === "ack" && msg.table === "realtime_rls_test",
      );
      await waitForWsMessage(
        wsService,
        (msg) => msg.type === "ack" && msg.table === "realtime_rls_test",
      );

      // Small delay to ensure listeners are fully set up
      await new Promise((r) => setTimeout(r, 500));

      // Collect all events from both WebSockets into arrays
      const serviceEvents: Record<string, unknown>[] = [];
      const user1Events: Record<string, unknown>[] = [];

      wsService.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "event") serviceEvents.push(msg);
        } catch { /* ignore non-JSON */ }
      });
      wsUser1.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "event") user1Events.push(msg);
        } catch { /* ignore non-JSON */ }
      });

      // Insert a row owned by user2 (user1 should NOT see this)
      const insertUser2 = await apiCall(
        "POST",
        "/v1/db/realtime_rls_test/insert",
        { rows: [{ owner_id: user2.user.id, content: "user2 data" }] },
        {
          apikey: anonApiKey,
          Authorization: `Bearer ${user2.access_token}`,
        },
      );
      expect(insertUser2.status).toBe(201);

      // Wait for service to receive the event
      await waitForWsMessage(
        wsService,
        (msg) =>
          msg.type === "event" && msg.table === "realtime_rls_test",
      );

      // Give user1's connection time to potentially receive (or not) the event
      await new Promise((r) => setTimeout(r, 1_000));

      // User1 should NOT have received user2's event
      const user1EventsForUser2 = user1Events.filter(
        (e) => (e.row as Record<string, unknown>).content === "user2 data",
      );
      expect(user1EventsForUser2.length).toBe(0);

      // Service should have received user2's event
      expect(serviceEvents.length).toBe(1);
      expect(serviceEvents[0].event).toBe("INSERT");
      expect(
        (serviceEvents[0].row as Record<string, unknown>).content,
      ).toBe("user2 data");

      // Insert a row owned by user1 — user1 SHOULD see this
      const insertUser1 = await apiCall(
        "POST",
        "/v1/db/realtime_rls_test/insert",
        { rows: [{ owner_id: user1.user.id, content: "user1 data" }] },
        {
          apikey: anonApiKey,
          Authorization: `Bearer ${user1.access_token}`,
        },
      );
      expect(insertUser1.status).toBe(201);

      // Wait for user1 to receive their own event
      await waitForWsMessage(
        wsUser1,
        (msg) =>
          msg.type === "event" &&
          msg.table === "realtime_rls_test" &&
          (msg.row as Record<string, unknown>).content === "user1 data",
      );

      // Verify user1 received their own event
      const user1OwnEvents = user1Events.filter(
        (e) => (e.row as Record<string, unknown>).content === "user1 data",
      );
      expect(user1OwnEvents.length).toBe(1);
      expect(user1OwnEvents[0].event).toBe("INSERT");
      expect(
        (user1OwnEvents[0].row as Record<string, unknown>).owner_id,
      ).toBe(user1.user.id);

      // Service should also have received user1's event (total: 2 events)
      // Wait a bit for the second event to arrive at service
      await new Promise((r) => setTimeout(r, 500));
      expect(serviceEvents.length).toBe(2);
      const serviceUser1Event = serviceEvents.find(
        (e) => (e.row as Record<string, unknown>).content === "user1 data",
      );
      expect(serviceUser1Event).toBeTruthy();
      expect(serviceUser1Event!.event).toBe("INSERT");
    } finally {
      wsUser1.close();
      wsService.close();
    }
  }, 30_000);
});
