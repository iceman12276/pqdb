import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";
import { column } from "../../src/query/schema.js";
import { computeBlindIndex } from "../../src/crypto/blind-index.js";
import { generateHmacKey } from "../../src/crypto/hmac.js";
import { deriveKeyPair, encrypt } from "../../src/crypto/encryption.js";

// A stable HMAC key for deterministic test assertions
const TEST_HMAC_KEY = generateHmacKey();
const TEST_HMAC_KEY_HEX = Array.from(TEST_HMAC_KEY)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

describe("SDK encryption integration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encrypts insert rows with searchable and private columns", async () => {
    // Mock HMAC key retrieval
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hmac_key: TEST_HMAC_KEY_HEX }),
    });

    // Mock insert response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_test", {
      encryptionKey: "my-secret-key",
    });

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      name: column.text().sensitive("private"),
      age: column.integer(),
    });

    await client.from(users).insert([
      { id: "1", email: "alice@example.com", name: "Alice", age: 30 },
    ]).execute();

    // First call should be HMAC key retrieval
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [hmacUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(hmacUrl).toContain("/v1/projects/hmac-key");

    // Second call should be the insert
    const [insertUrl, insertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(insertUrl).toBe("http://localhost:3000/v1/db/users/insert");
    const body = JSON.parse(insertInit.body as string);
    const row = body.rows[0];

    // Original sensitive columns should NOT be present
    expect(row).not.toHaveProperty("email");
    expect(row).not.toHaveProperty("name");

    // Shadow columns should be present
    expect(row).toHaveProperty("email_encrypted");
    expect(row).toHaveProperty("email_index");
    expect(row).toHaveProperty("name_encrypted");
    expect(row).not.toHaveProperty("name_index");

    // Plain columns should pass through
    expect(row.id).toBe("1");
    expect(row.age).toBe(30);

    // Verify the blind index is correct
    const expectedIndex = computeBlindIndex("alice@example.com", TEST_HMAC_KEY);
    expect(row.email_index).toBe(expectedIndex);
  });

  it("rewrites .eq() filter on searchable column to use _index", async () => {
    // Mock HMAC key retrieval
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hmac_key: TEST_HMAC_KEY_HEX }),
    });

    // Mock select response (return encrypted data)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_test", {
      encryptionKey: "my-secret-key",
    });

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      name: column.text().sensitive("private"),
      age: column.integer(),
    });

    await client.from(users).select().eq("email", "alice@example.com").execute();

    const [, selectInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(selectInit.body as string);

    // Filter should be rewritten
    expect(body.filters).toHaveLength(1);
    expect(body.filters[0].column).toBe("email_index");
    expect(body.filters[0].op).toBe("eq");
    expect(body.filters[0].value).toBe(
      computeBlindIndex("alice@example.com", TEST_HMAC_KEY),
    );
  });

  it("decrypts select response and restores original column names", async () => {
    const kp = await deriveKeyPair("my-secret-key");

    // Encrypt test data to simulate server response
    const emailCt = await encrypt("alice@example.com", kp.publicKey);
    const nameCt = await encrypt("Alice", kp.publicKey);

    const emailB64 = btoa(String.fromCharCode(...emailCt));
    const nameB64 = btoa(String.fromCharCode(...nameCt));
    const emailIndex = computeBlindIndex("alice@example.com", TEST_HMAC_KEY);

    // Mock HMAC key retrieval
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hmac_key: TEST_HMAC_KEY_HEX }),
    });

    // Mock select response with encrypted data
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "1",
          email_encrypted: emailB64,
          email_index: emailIndex,
          name_encrypted: nameB64,
          age: 30,
        },
      ],
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_test", {
      encryptionKey: "my-secret-key",
    });

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      name: column.text().sensitive("private"),
      age: column.integer(),
    });

    const { data, error } = await client.from(users).select().execute();

    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    // Developer should see original column names with plaintext
    expect(data![0]).toEqual({
      id: "1",
      email: "alice@example.com",
      name: "Alice",
      age: 30,
    });
  });

  it("caches HMAC key across multiple queries", async () => {
    // Mock HMAC key retrieval (only once)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hmac_key: TEST_HMAC_KEY_HEX }),
    });

    // Mock two query responses
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    });
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_test", {
      encryptionKey: "my-secret-key",
    });

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      age: column.integer(),
    });

    // Two queries
    await client.from(users).select().execute();
    await client.from(users).select().execute();

    // Should have made 3 fetch calls total: 1 HMAC + 2 queries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects range query on searchable column with clear error", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_test", {
      encryptionKey: "my-secret-key",
    });

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
      age: column.integer(),
    });

    const { data, error } = await client
      .from(users)
      .select()
      .gt("email", "a")
      .execute();

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/Range queries not supported on encrypted columns/);
  });

  it("rejects filter on private column with clear error", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_test", {
      encryptionKey: "my-secret-key",
    });

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      name: column.text().sensitive("private"),
      age: column.integer(),
    });

    const { data, error } = await client
      .from(users)
      .select()
      .eq("name", "Alice")
      .execute();

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/Cannot filter on private column/);
  });

  it("works without encryptionKey for tables with only plain columns", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", age: 30 }],
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_test");

    const metrics = client.defineTable("metrics", {
      id: column.uuid().primaryKey(),
      age: column.integer(),
    });

    const { data, error } = await client.from(metrics).select().execute();

    expect(error).toBeNull();
    expect(data).toEqual([{ id: "1", age: 30 }]);
    // No HMAC key fetch should happen
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns error if encryption key is missing but schema has sensitive columns", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_test");

    const users = client.defineTable("users", {
      id: column.uuid().primaryKey(),
      email: column.text().sensitive("searchable"),
    });

    const { data, error } = await client
      .from(users)
      .insert([{ id: "1", email: "test@test.com" }])
      .execute();

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/encryptionKey is required/);
  });
});
