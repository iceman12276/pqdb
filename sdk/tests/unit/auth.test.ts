import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

const MOCK_TOKENS = {
  access_token: "jwt-access-token",
  refresh_token: "jwt-refresh-token",
  token_type: "bearer",
};

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function mockFetchError(status: number, detail: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({ detail }),
  });
}

describe("AuthClient.signUp", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/signup with credentials", async () => {
    const fetchMock = mockFetchOk(MOCK_TOKENS);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.signUp({ email: "user@test.com", password: "pass123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/signup");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "user@test.com",
      password: "pass123",
    });
  });

  it("returns { data, error: null } on success", async () => {
    vi.stubGlobal("fetch", mockFetchOk(MOCK_TOKENS));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.signUp({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toEqual(MOCK_TOKENS);
    expect(result.error).toBeNull();
  });

  it("returns { data: null, error } on failure", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "Email already exists"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.signUp({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: "HTTP_400",
      message: "Email already exists",
    });
  });

  it("stores tokens after successful signUp", async () => {
    const fetchMock = mockFetchOk(MOCK_TOKENS);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.signUp({ email: "user@test.com", password: "pass123" });

    // Make another request — it should include the Authorization header
    await client.auth.signUp({ email: "another@test.com", password: "pass" });

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer jwt-access-token");
  });
});

describe("AuthClient.signIn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/login with credentials", async () => {
    const fetchMock = mockFetchOk(MOCK_TOKENS);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/login");
    expect(init.method).toBe("POST");
  });

  it("returns { data, error: null } on success", async () => {
    vi.stubGlobal("fetch", mockFetchOk(MOCK_TOKENS));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.signIn({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toEqual(MOCK_TOKENS);
    expect(result.error).toBeNull();
  });

  it("stores tokens after successful signIn", async () => {
    const fetchMock = mockFetchOk(MOCK_TOKENS);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    // Next request should include the Bearer token
    await client.auth.signIn({ email: "another@test.com", password: "pass" });

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer jwt-access-token");
  });

  it("returns error on invalid credentials", async () => {
    vi.stubGlobal("fetch", mockFetchError(401, "Invalid credentials"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.signIn({
      email: "user@test.com",
      password: "wrong",
    });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_401");
  });
});

describe("AuthClient.signOut", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clears stored tokens", async () => {
    const fetchMock = mockFetchOk(MOCK_TOKENS);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");

    // Sign in to store tokens
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    // Sign out
    client.auth.signOut();

    // Next request should NOT include Authorization header
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("AuthClient token auto-refresh", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refreshes token on 401 and retries the request", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      // First call (signIn) — succeeds, stores tokens
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => MOCK_TOKENS,
        };
      }
      // Second call (signIn again) — 401 triggers refresh
      if (callCount === 2) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ detail: "Token expired" }),
        };
      }
      // Third call (refresh endpoint)
      if (callCount === 3) {
        expect(url).toContain("/v1/auth/refresh");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-access-token",
            token_type: "bearer",
          }),
        };
      }
      // Fourth call (retry of the original request)
      if (callCount === 4) {
        return {
          ok: true,
          status: 200,
          json: async () => MOCK_TOKENS,
        };
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");

    // Sign in to get tokens
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    // This request will get a 401, trigger refresh, then retry
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    // Should have: signIn(1) + fail(2) + refresh(3) + retry(4)
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Verify the retry used the new access token
    const [, retryInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    const headers = retryInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer new-access-token");
  });

  it("returns error if refresh also fails", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      // First call (signIn) — succeeds
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => MOCK_TOKENS,
        };
      }
      // Second call — 401
      if (callCount === 2) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ detail: "Token expired" }),
        };
      }
      // Third call (refresh) — also fails
      if (callCount === 3) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ detail: "Refresh token expired" }),
        };
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.signIn({ email: "user@test.com", password: "pass123" });

    const result = await client.auth.signIn({
      email: "user@test.com",
      password: "pass",
    });

    // Should return the original 401 error
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_401");
  });
});

describe("HTTP error handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns NETWORK_ERROR on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Failed to fetch")),
    );

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.signUp({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: "NETWORK_ERROR",
      message: "Failed to fetch",
    });
  });
});
