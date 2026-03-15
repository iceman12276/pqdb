/**
 * Phase 2a E2E tests: key rotation, re-indexing, end-user auth + RLS.
 *
 * These tests boot a real uvicorn server against real Postgres + Vault,
 * then exercise the full stack via the @pqdb/client SDK.
 *
 * Tests:
 *  1 — Key rotation round-trip (insert pre-rotation, rotate, insert post, query)
 *  2 — Re-indexing (rotate, reindex, verify indexes updated, delete old key)
 *  3 — User signup + login + RLS (owner column isolation)
 *  4 — Service role bypass (service key sees all rows)
 *  5 — Cross-project user isolation (user JWT rejected on different project)
 *  6 — Session revocation (logout invalidates refresh token)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { createClient, column } from "../../src/index.js";
import { deriveKeyPair, decrypt } from "../../src/crypto/encryption.js";
import { computeBlindIndex } from "../../src/crypto/blind-index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_PORT = 8766;
const API_URL = `http://localhost:${API_PORT}`;
const BACKEND_DIR = path.resolve(__dirname, "../../../backend");
const ENCRYPTION_KEY = "e2e-phase2a-master-key-for-pqc";

const RUN_ID = Date.now();
const DEV_EMAIL = `e2e-p2a-${RUN_ID}@test.pqdb.dev`;
const DEV_PASSWORD = "SuperSecretP@ss123!";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess;
let developerAccessToken: string;
let projectId: string;
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

/** Convert hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Decode base64 string to Uint8Array. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.includes("ERROR") || msg.includes("Traceback")) {
      console.error("[backend]", msg);
    }
  });

  await waitForServer();

  // --- Platform setup: signup developer, create project, get keys ---
  const tempClient = createClient(API_URL, "pqdb_anon_placeholder00000000");
  const signupResult = await tempClient.auth.signUp({
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
  });
  expect(signupResult.error).toBeNull();
  developerAccessToken = signupResult.data!.access_token;

  const createResult = await apiCall(
    "POST",
    "/v1/projects",
    { name: "e2e-phase2a-project", region: "us-east-1" },
    { Authorization: `Bearer ${developerAccessToken}` },
  );
  expect(createResult.status).toBe(201);
  const project = createResult.json as {
    id: string;
    api_keys: Array<{ role: string; key: string }>;
  };
  projectId = project.id;
  serviceApiKey = project.api_keys.find((k) => k.role === "service")!.key;
  anonApiKey = project.api_keys.find((k) => k.role === "anon")!.key;
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
// Test 1 — Key rotation round-trip
// ===========================================================================
describe("Test 1 — Key rotation round-trip", () => {
  it("inserts data, rotates key, inserts more, and queries return both old and new rows", async () => {
    // Create table with a searchable column
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "rotation_test",
        columns: [
          { name: "email", data_type: "text", sensitivity: "searchable" },
          { name: "label", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    const client = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const rotationTable = client.defineTable("rotation_test", {
      email: column.text().sensitive("searchable"),
      label: column.text(),
    });

    // Insert row BEFORE rotation
    const insertBefore = await client
      .from(rotationTable)
      .insert([{ email: "before@test.com", label: "pre-rotation" }])
      .execute();
    expect(insertBefore.error).toBeNull();

    // Verify raw index is v1
    const rawBefore = await apiCall(
      "POST",
      "/v1/db/rotation_test/select",
      { filters: [] },
      { apikey: serviceApiKey },
    );
    const rawRowsBefore = (rawBefore.json as { data: Record<string, unknown>[] }).data;
    expect(rawRowsBefore[0].email_index as string).toMatch(/^v1:/);

    // Rotate HMAC key
    const rotateResult = await apiCall(
      "POST",
      `/v1/projects/${projectId}/hmac-key/rotate`,
      {},
      { Authorization: `Bearer ${developerAccessToken}` },
    );
    expect(rotateResult.status).toBe(200);
    const rotateData = rotateResult.json as {
      previous_version: number;
      current_version: number;
    };
    expect(rotateData.current_version).toBeGreaterThan(rotateData.previous_version);

    // Insert row AFTER rotation (fresh client to pick up new HMAC key)
    const client2 = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const rotationTable2 = client2.defineTable("rotation_test", {
      email: column.text().sensitive("searchable"),
      label: column.text(),
    });

    const insertAfter = await client2
      .from(rotationTable2)
      .insert([{ email: "after@test.com", label: "post-rotation" }])
      .execute();
    expect(insertAfter.error).toBeNull();

    // Verify version prefixes differ in raw database
    const rawAfter = await apiCall(
      "POST",
      "/v1/db/rotation_test/select",
      { filters: [] },
      { apikey: serviceApiKey },
    );
    const rawRowsAfter = (rawAfter.json as { data: Record<string, unknown>[] }).data;
    const preRow = rawRowsAfter.find((r) => r.label === "pre-rotation");
    const postRow = rawRowsAfter.find((r) => r.label === "post-rotation");
    expect(preRow).toBeTruthy();
    expect(postRow).toBeTruthy();
    expect(preRow!.email_index as string).toMatch(/^v1:/);
    expect(postRow!.email_index as string).toMatch(/^v2:/);

    // SDK queries with .eq() find both old (v1) and new (v2) rows
    const selectBefore = await client2
      .from(rotationTable2)
      .select()
      .eq("email", "before@test.com")
      .execute();
    expect(selectBefore.error).toBeNull();
    expect(selectBefore.data!.length).toBe(1);
    expect(selectBefore.data![0].email).toBe("before@test.com");

    const selectAfter = await client2
      .from(rotationTable2)
      .select()
      .eq("email", "after@test.com")
      .execute();
    expect(selectAfter.error).toBeNull();
    expect(selectAfter.data!.length).toBe(1);
    expect(selectAfter.data![0].email).toBe("after@test.com");
  }, 60_000);
});

// ===========================================================================
// Test 2 — Re-indexing
// ===========================================================================
describe("Test 2 — Re-indexing", () => {
  it("re-indexes after rotation, verifies all indexes updated, deletes old key", async () => {
    // rotation_test has v1 and v2 rows from Test 1.
    // We manually orchestrate the reindex because the SDK's reindex()
    // sets a developer JWT that conflicts with the user_auth middleware
    // on /v1/db/* endpoints.

    const devAuth = { Authorization: `Bearer ${developerAccessToken}` };

    // Step 1: Get versioned HMAC keys (via apikey endpoint)
    const hmacResp = await apiCall(
      "GET",
      "/v1/db/hmac-key",
      undefined,
      { apikey: serviceApiKey },
    );
    expect(hmacResp.status).toBe(200);
    const hmacData = hmacResp.json as {
      current_version: number;
      keys: Record<string, string>;
    };
    const currentVersion = hmacData.current_version;
    expect(currentVersion).toBeGreaterThanOrEqual(2); // At least v2 after Test 1 rotation
    const currentKeyBytes = hexToBytes(hmacData.keys[String(currentVersion)]);

    // Step 2: Start reindex job (developer JWT)
    const startResp = await apiCall(
      "POST",
      `/v1/projects/${projectId}/reindex`,
      {},
      devAuth,
    );
    expect(startResp.status).toBe(202);
    const startData = startResp.json as {
      job_id: string;
      tables: Array<{ table: string; searchable_columns: string[] }>;
    };
    expect(startData.tables.length).toBeGreaterThanOrEqual(1);
    const rotationTableInfo = startData.tables.find((t) => t.table === "rotation_test");
    expect(rotationTableInfo).toBeTruthy();

    // Step 3: Fetch all rows from the table (apikey, no developer JWT)
    const selectResp = await apiCall(
      "POST",
      "/v1/db/rotation_test/select",
      { columns: ["*"] },
      { apikey: serviceApiKey },
    );
    expect(selectResp.status).toBe(200);
    const rawRows = (selectResp.json as { data: Record<string, unknown>[] }).data;

    // Step 4: Decrypt and re-compute blind indexes client-side
    const keyPair = await deriveKeyPair(ENCRYPTION_KEY);
    const batchUpdates: Array<{ id: string; indexes: Record<string, string> }> = [];

    for (const row of rawRows) {
      const rowId = row["id"] as string;
      const indexes: Record<string, string> = {};

      for (const col of rotationTableInfo!.searchable_columns) {
        const encryptedValue = row[`${col}_encrypted`] as string | undefined;
        const currentIndex = row[`${col}_index`] as string | undefined;

        if (currentIndex?.startsWith(`v${currentVersion}:`)) continue;

        if (encryptedValue) {
          const ciphertext = fromBase64(encryptedValue);
          const plaintext = await decrypt(ciphertext, keyPair.secretKey);
          const newIndex = computeBlindIndex(plaintext, currentKeyBytes, currentVersion);
          indexes[`${col}_index`] = newIndex;
        }
      }

      if (Object.keys(indexes).length > 0) {
        batchUpdates.push({ id: String(rowId), indexes });
      }
    }

    expect(batchUpdates.length).toBeGreaterThanOrEqual(1); // At least the v1 row

    // Step 5: Send batch update (developer JWT)
    const batchResp = await apiCall(
      "POST",
      `/v1/projects/${projectId}/reindex/batch`,
      {
        job_id: startData.job_id,
        table: "rotation_test",
        updates: batchUpdates,
      },
      devAuth,
    );
    expect(batchResp.status).toBe(200);
    const batchData = batchResp.json as { rows_updated: number };
    expect(batchData.rows_updated).toBeGreaterThanOrEqual(1);

    // Step 6: Complete the job (developer JWT)
    const completeResp = await apiCall(
      "POST",
      `/v1/projects/${projectId}/reindex/complete`,
      { job_id: startData.job_id, tables_done: 1 },
      devAuth,
    );
    expect(completeResp.status).toBe(200);

    // Verify all _index values are now on current version
    const rawAfterReindex = await apiCall(
      "POST",
      "/v1/db/rotation_test/select",
      { filters: [] },
      { apikey: serviceApiKey },
    );
    const reindexedRows = (rawAfterReindex.json as { data: Record<string, unknown>[] }).data;
    const versionPrefix = `v${currentVersion}:`;
    for (const row of reindexedRows) {
      expect(row.email_index as string).toMatch(new RegExp(`^${versionPrefix}`));
    }

    // Delete old key version (v1)
    const deleteKeyResp = await apiCall(
      "DELETE",
      `/v1/projects/${projectId}/hmac-key/versions/1`,
      undefined,
      devAuth,
    );
    expect(deleteKeyResp.status).toBe(200);

    // Queries still work with only v2 key
    const client3 = createClient(API_URL, serviceApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const rotationTable3 = client3.defineTable("rotation_test", {
      email: column.text().sensitive("searchable"),
      label: column.text(),
    });

    const selectStillWorks = await client3
      .from(rotationTable3)
      .select()
      .eq("email", "before@test.com")
      .execute();
    expect(selectStillWorks.error).toBeNull();
    expect(selectStillWorks.data!.length).toBe(1);
    expect(selectStillWorks.data![0].email).toBe("before@test.com");
  }, 60_000);
});

// ===========================================================================
// Test 3 — User signup + login + RLS
// ===========================================================================
describe("Test 3 — User signup + login + RLS", () => {
  it("user A sees own rows, user B sees zero rows", async () => {
    // Create table with owner column
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "rls_test",
        columns: [
          { name: "owner_id", data_type: "uuid", sensitivity: "plain", owner: true },
          { name: "note", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: serviceApiKey },
    );
    expect(createTable.status).toBe(201);

    // Sign up user A via anon key
    const signupA = await apiCall(
      "POST",
      "/v1/auth/users/signup",
      { email: `userA-${RUN_ID}@test.pqdb.dev`, password: "UserAPass123!" },
      { apikey: anonApiKey },
    );
    expect(signupA.status).toBe(201);
    const userAData = signupA.json as {
      user: { id: string };
      access_token: string;
      refresh_token: string;
    };
    const userAId = userAData.user.id;
    const userAToken = userAData.access_token;

    // Insert rows as user A (manually set owner_id + pass user JWT)
    const insertA = await apiCall(
      "POST",
      "/v1/db/rls_test/insert",
      {
        rows: [
          { owner_id: userAId, note: "User A note 1" },
          { owner_id: userAId, note: "User A note 2" },
        ],
      },
      { apikey: anonApiKey, Authorization: `Bearer ${userAToken}` },
    );
    expect(insertA.status).toBe(201);
    const insertedRows = (insertA.json as { data: Record<string, unknown>[] }).data;
    expect(insertedRows.length).toBe(2);

    // Sign up user B
    const signupB = await apiCall(
      "POST",
      "/v1/auth/users/signup",
      { email: `userB-${RUN_ID}@test.pqdb.dev`, password: "UserBPass123!" },
      { apikey: anonApiKey },
    );
    expect(signupB.status).toBe(201);
    const userBData = signupB.json as {
      user: { id: string };
      access_token: string;
    };
    expect(userBData.user.id).not.toBe(userAId);
    const userBToken = userBData.access_token;

    // User B queries — sees zero rows (RLS: anon only sees own rows)
    const selectB = await apiCall(
      "POST",
      "/v1/db/rls_test/select",
      { filters: [] },
      { apikey: anonApiKey, Authorization: `Bearer ${userBToken}` },
    );
    expect(selectB.status).toBe(200);
    const rowsB = (selectB.json as { data: Record<string, unknown>[] }).data;
    expect(rowsB).toEqual([]);

    // User A queries — sees own rows
    const selectA = await apiCall(
      "POST",
      "/v1/db/rls_test/select",
      { filters: [] },
      { apikey: anonApiKey, Authorization: `Bearer ${userAToken}` },
    );
    expect(selectA.status).toBe(200);
    const rowsA = (selectA.json as { data: Record<string, unknown>[] }).data;
    expect(rowsA.length).toBe(2);
    for (const row of rowsA) {
      expect(row.owner_id).toBe(userAId);
    }
  }, 60_000);
});

// ===========================================================================
// Test 4 — Service role bypass
// ===========================================================================
describe("Test 4 — Service role bypass", () => {
  it("service role API key sees all rows from all users", async () => {
    // Service role key, no user JWT — should see ALL rows (no RLS filtering)
    const selectAll = await apiCall(
      "POST",
      "/v1/db/rls_test/select",
      { filters: [] },
      { apikey: serviceApiKey },
    );
    expect(selectAll.status).toBe(200);
    const allRows = (selectAll.json as { data: Record<string, unknown>[] }).data;
    // At least the 2 rows from user A in Test 3
    expect(allRows.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

// ===========================================================================
// Test 5 — Cross-project user isolation
// ===========================================================================
describe("Test 5 — Cross-project user isolation", () => {
  it("user A's JWT from project A is rejected on project B", async () => {
    // Create a second project
    const createProject2 = await apiCall(
      "POST",
      "/v1/projects",
      { name: "e2e-phase2a-project-b", region: "us-east-1" },
      { Authorization: `Bearer ${developerAccessToken}` },
    );
    expect(createProject2.status).toBe(201);
    const projectB = createProject2.json as {
      id: string;
      api_keys: Array<{ role: string; key: string }>;
    };
    const projectBAnonKey = projectB.api_keys.find((k) => k.role === "anon")!.key;
    const projectBServiceKey = projectB.api_keys.find((k) => k.role === "service")!.key;

    // Create table in project B
    const createTable = await apiCall(
      "POST",
      "/v1/db/tables",
      {
        name: "isolation_test",
        columns: [
          { name: "owner_id", data_type: "uuid", sensitivity: "plain", owner: true },
          { name: "data", data_type: "text", sensitivity: "plain" },
        ],
      },
      { apikey: projectBServiceKey },
    );
    expect(createTable.status).toBe(201);

    // Sign in user A (from project A, already signed up in Test 3)
    const clientA = createClient(API_URL, anonApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const loginA = await clientA.auth.users.signIn({
      email: `userA-${RUN_ID}@test.pqdb.dev`,
      password: "UserAPass123!",
    });
    expect(loginA.error).toBeNull();
    const userAAccessToken = loginA.data!.access_token;

    // Use user A's JWT (from project A) against project B's anon key
    const crossProjectInsert = await apiCall(
      "POST",
      "/v1/db/isolation_test/insert",
      { rows: [{ data: "sneaky" }] },
      {
        apikey: projectBAnonKey,
        Authorization: `Bearer ${userAAccessToken}`,
      },
    );
    expect(crossProjectInsert.status).toBe(401);
  }, 60_000);
});

// ===========================================================================
// Test 6 — Session revocation
// ===========================================================================
describe("Test 6 — Session revocation", () => {
  it("refresh token is rejected after logout", async () => {
    const client = createClient(API_URL, anonApiKey, {
      encryptionKey: ENCRYPTION_KEY,
    });

    const email = `revoke-${RUN_ID}@test.pqdb.dev`;
    const password = "RevokePass123!";

    // Sign up
    const signup = await client.auth.users.signUp({ email, password });
    expect(signup.error).toBeNull();
    const refreshToken = signup.data!.refresh_token;

    // Log out (revokes the signup session's refresh token)
    const logoutResult = await client.auth.users.signOut();
    expect(logoutResult.error).toBeNull();

    // Try to refresh with the now-revoked token
    const refreshAttempt = await apiCall(
      "POST",
      "/v1/auth/users/refresh",
      { refresh_token: refreshToken },
      { apikey: anonApiKey },
    );
    expect(refreshAttempt.status).toBe(401);
  }, 30_000);
});
