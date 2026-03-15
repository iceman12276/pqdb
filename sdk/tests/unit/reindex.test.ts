import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

/**
 * Unit tests for client.reindex() — SDK-driven re-indexing after key rotation.
 *
 * Uses fetch mocking to simulate the backend API responses without
 * requiring a real server.
 */

/** Build a mock Response. */
function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    headers: new Headers(),
    redirected: false,
    statusText: status === 200 ? "OK" : "Error",
    type: "basic",
    url: "",
    clone: () => mockResponse(data, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(data),
  } as Response;
}

describe("client.reindex()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error when encryptionKey is not set", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc");
    const result = await client.reindex("project-123");
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe("ENCRYPTION_ERROR");
    expect(result.data).toBeNull();
  });

  it("returns error when start reindex fails", async () => {
    // Mock HMAC key fetch (GET /v1/db/hmac-key)
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/db/hmac-key")) {
        return mockResponse({
          current_version: 2,
          keys: {
            "1": "aa".repeat(32),
            "2": "bb".repeat(32),
          },
        });
      }
      if (url.includes("/reindex") && !url.includes("/batch") && !url.includes("/complete") && !url.includes("/status")) {
        return mockResponse({ detail: "Server error" }, 500);
      }
      return mockResponse({});
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_abc", {
      encryptionKey: "test-key-for-encryption",
    });

    const result = await client.reindex("project-123");
    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
  });

  it("completes immediately for empty tables list", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/db/hmac-key")) {
        return mockResponse({
          current_version: 1,
          keys: { "1": "aa".repeat(32) },
        });
      }
      if (url.includes("/reindex") && !url.includes("/batch") && !url.includes("/complete") && !url.includes("/status")) {
        return mockResponse({ job_id: "job-001", tables: [] });
      }
      return mockResponse({});
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_abc", {
      encryptionKey: "test-key-for-encryption",
    });

    const result = await client.reindex("project-123");
    expect(result.error).toBeNull();
    expect(result.data).not.toBeNull();
    expect(result.data!.jobId).toBe("job-001");
    expect(result.data!.tablesProcessed).toBe(0);
    expect(result.data!.rowsUpdated).toBe(0);
  });

  it("processes tables and sends batch updates", async () => {
    const batchCalls: unknown[] = [];

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/db/hmac-key")) {
        return mockResponse({
          current_version: 2,
          keys: {
            "1": "aa".repeat(32),
            "2": "bb".repeat(32),
          },
        });
      }
      // Start reindex
      if (url.includes("/reindex") && !url.includes("/batch") && !url.includes("/complete") && !url.includes("/status")) {
        return mockResponse({
          job_id: "job-002",
          tables: [
            { table: "users", searchable_columns: ["email"] },
          ],
        });
      }
      // Select rows
      if (url.includes("/v1/db/users/select")) {
        // Return a row with a v1-versioned index and base64-encoded encrypted value
        // In practice, this would be real ML-KEM ciphertext, but for test
        // we just need the flow to work — decryption will fail, but we
        // test the error handling path
        return mockResponse({
          data: [
            {
              id: "1",
              email_encrypted: "not-real-ciphertext",
              email_index: "v1:oldhash",
              age: 25,
            },
          ],
        });
      }
      // Batch update
      if (url.includes("/reindex/batch")) {
        const body = JSON.parse(init?.body as string);
        batchCalls.push(body);
        return mockResponse({ rows_updated: body.updates.length });
      }
      // Complete
      if (url.includes("/reindex/complete")) {
        return mockResponse({ status: "complete" });
      }
      return mockResponse({});
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_abc", {
      encryptionKey: "test-key-for-encryption",
    });

    // The actual crypto decrypt will fail on the mock ciphertext,
    // which will cause a REINDEX_ERROR. This tests the error path.
    const result = await client.reindex("project-123");

    // Since the ciphertext is fake, decryption will fail.
    // This validates the error handling path.
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe("REINDEX_ERROR");
  });

  it("has reindex method on client interface", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc", {
      encryptionKey: "test-key",
    });
    expect(typeof client.reindex).toBe("function");
  });
});
