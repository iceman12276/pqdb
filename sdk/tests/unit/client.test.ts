import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

describe("createClient", () => {
  it("returns a client with an auth property", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc123");
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("accepts optional encryptionKey", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc123", {
      encryptionKey: "my-secret-key",
    });
    expect(client).toBeDefined();
  });

  it("strips trailing slash from project URL", () => {
    const client = createClient(
      "http://localhost:3000/",
      "pqdb_anon_abc123",
    );
    expect(client).toBeDefined();
  });
});

describe("HTTP header attachment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: "test" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends apikey header on all requests", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc123");

    await client.auth.signUp({ email: "test@test.com", password: "pass123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["apikey"]).toBe("pqdb_anon_abc123");
  });

  it("includes Content-Type: application/json on POST requests", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc123");

    await client.auth.signUp({ email: "test@test.com", password: "pass123" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
