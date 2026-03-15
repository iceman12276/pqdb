/**
 * E2E tests: real TypeScript SDK against real FastAPI backend.
 *
 * These tests boot a real uvicorn server, connect to real Postgres + Vault,
 * and exercise the full encrypt → store → query → decrypt round-trip
 * using the actual @pqdb/client SDK with ML-KEM-768 and HMAC-SHA3-256.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { createClient, column } from "../../src/index.js";
import type { PqdbClient } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_PORT = 8765;
const API_URL = `http://localhost:${API_PORT}`;
const BACKEND_DIR = path.resolve(__dirname, "../../../backend");
const ENCRYPTION_KEY = "e2e-test-master-key-for-pqc";

// Unique email per test run to avoid signup conflicts
const TEST_EMAIL = `e2e-${Date.now()}@test.pqdb.dev`;
const TEST_PASSWORD = "SuperSecretP@ss123!";

// ---------------------------------------------------------------------------
// Shared state across tests
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess;
let developerAccessToken: string;
let projectId: string;
let serviceApiKey: string;
let anonApiKey: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Direct HTTP call (bypass SDK) for platform endpoints. */
async function apiCall(
  method: string,
  path: string,
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
  const resp = await fetch(`${API_URL}${path}`, opts);
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

/** Wait until /health returns 200 or timeout. */
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

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  serverProcess = spawn(
    "uv",
    ["run", "uvicorn", "pqdb_api.app:create_app", "--factory", "--port", String(API_PORT)],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PQDB_DATABASE_URL: "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_platform",
        PQDB_VAULT_ADDR: "http://localhost:8200",
        PQDB_VAULT_TOKEN: "dev-root-token",
        PQDB_SUPERUSER_DSN: "postgresql://postgres:postgres@localhost:5432/postgres",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Capture stderr for debugging if tests fail
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.includes("ERROR") || msg.includes("Traceback")) {
      console.error("[backend]", msg);
    }
  });

  await waitForServer();
}, 60_000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    // Give it a moment to shut down
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProcess.killed) {
      serverProcess.kill("SIGKILL");
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: full SDK round-trip", () => {
  // -----------------------------------------------------------------------
  // Test 1 — Platform flow
  // -----------------------------------------------------------------------
  it("signs up, creates a project, and gets API keys", async () => {
    // 1a. Sign up via SDK auth
    const tempClient = createClient(API_URL, "pqdb_anon_placeholder00000000");
    const signupResult = await tempClient.auth.signUp({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    expect(signupResult.error).toBeNull();
    expect(signupResult.data).toBeTruthy();
    developerAccessToken = signupResult.data!.access_token;
    expect(developerAccessToken).toBeTruthy();

    // 1b. Create a project (direct HTTP — SDK doesn't expose project management)
    const createResult = await apiCall(
      "POST",
      "/v1/projects",
      { name: "e2e-test-project", region: "us-east-1" },
      { Authorization: `Bearer ${developerAccessToken}` },
    );

    expect(createResult.status).toBe(201);
    const project = createResult.json as {
      id: string;
      name: string;
      status: string;
      api_keys: Array<{ role: string; key: string }>;
    };

    expect(project.status).toBe("active");
    projectId = project.id;

    // Extract API keys
    const serviceKey = project.api_keys.find((k) => k.role === "service");
    const anonKey = project.api_keys.find((k) => k.role === "anon");
    expect(serviceKey).toBeTruthy();
    expect(anonKey).toBeTruthy();
    serviceApiKey = serviceKey!.key;
    anonApiKey = anonKey!.key;
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 2 — Schema flow
  // -----------------------------------------------------------------------
  it("creates a table and verifies shadow columns via introspect", async () => {
    // Create table via direct HTTP (table management uses API key auth)
    const createTableResult = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "contacts",
        columns: [
          { name: "email", data_type: "text", sensitivity: "searchable" },
          { name: "phone", data_type: "text", sensitivity: "private" },
          { name: "nickname", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );

    expect(createTableResult.status).toBe(201);

    // Introspect to verify shadow columns
    const introspectResult = await apiCall("GET", "/v1/db/introspect/contacts", undefined, {
      apikey: serviceApiKey,
    });

    expect(introspectResult.status).toBe(200);
    const introspection = introspectResult.json as {
      name: string;
      columns: Array<{
        name: string;
        sensitivity: string;
        queryable: boolean;
        operations?: string[];
        note?: string;
      }>;
      sensitivity_summary: Record<string, number>;
    };

    expect(introspection.name).toBe("contacts");

    // Find the email column — searchable, queryable with eq/in
    const emailCol = introspection.columns.find((c) => c.name === "email");
    expect(emailCol).toBeTruthy();
    expect(emailCol!.sensitivity).toBe("searchable");
    expect(emailCol!.queryable).toBe(true);
    expect(emailCol!.operations).toContain("eq");
    expect(emailCol!.operations).toContain("in");

    // Find the phone column — private, not queryable
    const phoneCol = introspection.columns.find((c) => c.name === "phone");
    expect(phoneCol).toBeTruthy();
    expect(phoneCol!.sensitivity).toBe("private");
    expect(phoneCol!.queryable).toBe(false);

    // Plain column — queryable with all operations
    const nicknameCol = introspection.columns.find((c) => c.name === "nickname");
    expect(nicknameCol).toBeTruthy();
    expect(nicknameCol!.sensitivity).toBe("plain");
    expect(nicknameCol!.queryable).toBe(true);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 3 — Insert + Select round-trip
  // -----------------------------------------------------------------------
  it("inserts via SDK with real encryption and selects back with decryption", async () => {
    const client = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });

    const contacts = client.defineTable("contacts", {
      email: column.text().sensitive("searchable"),
      phone: column.text().sensitive("private"),
      nickname: column.text(),
    });

    // Insert a row — SDK encrypts with ML-KEM-768 + computes HMAC blind index
    const insertResult = await client
      .from(contacts)
      .insert([
        { email: "alice@example.com", phone: "+1-555-0100", nickname: "Ali" },
      ])
      .execute();

    expect(insertResult.error).toBeNull();
    expect(insertResult.data).toBeTruthy();
    expect(insertResult.data!.length).toBe(1);

    // Select by searchable column — SDK computes blind index hash for .eq()
    const selectResult = await client
      .from(contacts)
      .select()
      .eq("email", "alice@example.com")
      .execute();

    expect(selectResult.error).toBeNull();
    expect(selectResult.data).toBeTruthy();
    expect(selectResult.data!.length).toBe(1);

    const row = selectResult.data![0];
    // SDK decrypts the response — we should see plaintext
    expect(row.email).toBe("alice@example.com");
    expect(row.phone).toBe("+1-555-0100");
    expect(row.nickname).toBe("Ali");
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 4 — Zero-knowledge verification
  // -----------------------------------------------------------------------
  it("verifies the database contains only ciphertext, never plaintext", async () => {
    // Query the project database directly via a raw select (no SDK decryption)
    // We use a second client without encryption key, or direct HTTP
    const rawSelect = await apiCall(
      "POST",
      "/v1/db/contacts/select",
      { filters: [] },
      { apikey: serviceApiKey },
    );

    expect(rawSelect.status).toBe(200);
    const rawData = (rawSelect.json as { data: Record<string, unknown>[] }).data;
    expect(rawData.length).toBeGreaterThanOrEqual(1);

    const rawRow = rawData[0];

    // The raw response should contain shadow columns, not original names
    expect(rawRow).toHaveProperty("email_encrypted");
    expect(rawRow).toHaveProperty("email_index");
    expect(rawRow).toHaveProperty("phone_encrypted");

    // The encrypted values should NOT be plaintext
    const emailEnc = rawRow.email_encrypted as string;
    const phoneEnc = rawRow.phone_encrypted as string;
    const emailIdx = rawRow.email_index as string;

    expect(emailEnc).not.toBe("alice@example.com");
    expect(phoneEnc).not.toBe("+1-555-0100");
    // Blind index is an HMAC hex hash — definitely not the email
    expect(emailIdx).not.toBe("alice@example.com");
    expect(emailIdx).toMatch(/^v\d+:[0-9a-f]{64}$/); // version-prefixed HMAC blind index

    // Plain column should pass through
    expect(rawRow.nickname).toBe("Ali");

    // The database should NOT have a column called "email" or "phone"
    expect(rawRow).not.toHaveProperty("email");
    expect(rawRow).not.toHaveProperty("phone");
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 5 — Update + Delete
  // -----------------------------------------------------------------------
  it("updates via blind index and deletes, verifying changes", async () => {
    const client = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });

    const contacts = client.defineTable("contacts", {
      email: column.text().sensitive("searchable"),
      phone: column.text().sensitive("private"),
      nickname: column.text(),
    });

    // Capture the original encrypted value via raw HTTP
    const beforeUpdate = await apiCall(
      "POST",
      "/v1/db/contacts/select",
      {
        filters: [],
      },
      { apikey: serviceApiKey },
    );
    const originalRow = (beforeUpdate.json as { data: Record<string, unknown>[] }).data[0];
    const originalPhoneEnc = originalRow.phone_encrypted as string;

    // Update: change the phone number (matched by email blind index)
    const updateResult = await client
      .from(contacts)
      .update({ phone: "+1-555-9999" })
      .eq("email", "alice@example.com")
      .execute();

    expect(updateResult.error).toBeNull();
    expect(updateResult.data).toBeTruthy();
    expect(updateResult.data!.length).toBe(1);

    // Verify the encrypted phone value changed
    const afterUpdate = await apiCall(
      "POST",
      "/v1/db/contacts/select",
      { filters: [] },
      { apikey: serviceApiKey },
    );
    const updatedRow = (afterUpdate.json as { data: Record<string, unknown>[] }).data[0];
    const newPhoneEnc = updatedRow.phone_encrypted as string;
    expect(newPhoneEnc).not.toBe(originalPhoneEnc);

    // Verify via SDK decryption that the update took effect
    const verifyResult = await client
      .from(contacts)
      .select()
      .eq("email", "alice@example.com")
      .execute();

    expect(verifyResult.data![0].phone).toBe("+1-555-9999");

    // Delete the row
    const deleteResult = await client
      .from(contacts)
      .delete()
      .eq("email", "alice@example.com")
      .execute();

    expect(deleteResult.error).toBeNull();
    expect(deleteResult.data).toBeTruthy();
    expect(deleteResult.data!.length).toBe(1);

    // Verify the row is gone
    const finalResult = await client
      .from(contacts)
      .select()
      .execute();

    expect(finalResult.data).toEqual([]);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 6 — Project isolation
  // -----------------------------------------------------------------------
  it("ensures data in project A is invisible from project B", async () => {
    // Create a second project
    const createResult = await apiCall(
      "POST",
      "/v1/projects",
      { name: "e2e-isolation-project", region: "us-east-1" },
      { Authorization: `Bearer ${developerAccessToken}` },
    );

    expect(createResult.status).toBe(201);
    const projectB = createResult.json as {
      id: string;
      status: string;
      api_keys: Array<{ role: string; key: string }>;
    };
    expect(projectB.status).toBe("active");

    const projectBServiceKey = projectB.api_keys.find((k) => k.role === "service")!.key;

    // Create the same table schema in project B
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "contacts",
        columns: [
          { name: "email", data_type: "text", sensitivity: "searchable" },
          { name: "phone", data_type: "text", sensitivity: "private" },
          { name: "nickname", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: projectBServiceKey },
    );
    expect(createTable.status).toBe(201);

    // Insert data in project A (original project)
    const clientA = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });

    const contactsA = clientA.defineTable("contacts", {
      email: column.text().sensitive("searchable"),
      phone: column.text().sensitive("private"),
      nickname: column.text(),
    });

    const insertA = await clientA
      .from(contactsA)
      .insert([{ email: "secretA@example.com", phone: "+1-000-0001", nickname: "ProjectA" }])
      .execute();
    expect(insertA.error).toBeNull();

    // Query from project B — should see NO data from project A
    const clientB = createClient(API_URL, projectBServiceKey, {
      encryptionKey: ENCRYPTION_KEY,
    });

    const contactsB = clientB.defineTable("contacts", {
      email: column.text().sensitive("searchable"),
      phone: column.text().sensitive("private"),
      nickname: column.text(),
    });

    const selectB = await clientB.from(contactsB).select().execute();
    expect(selectB.error).toBeNull();
    expect(selectB.data).toEqual([]);

    // Clean up: delete the row from project A
    await clientA.from(contactsA).delete().eq("email", "secretA@example.com").execute();
  }, 30_000);
});
