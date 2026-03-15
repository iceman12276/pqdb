import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

// Backend response shape for signup/login
const MOCK_USER_AUTH_RESPONSE = {
  user: {
    id: "user-uuid-123",
    email: "user@test.com",
    role: "authenticated",
    email_verified: false,
    metadata: {},
  },
  access_token: "user-access-token",
  refresh_token: "user-refresh-token",
  token_type: "bearer",
};

const MOCK_USER_PROFILE = {
  id: "user-uuid-123",
  email: "user@test.com",
  role: "authenticated",
  email_verified: false,
  metadata: {},
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

describe("UserAuthClient.signUp", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/signup with email and password", async () => {
    const fetchMock = mockFetchOk(MOCK_USER_AUTH_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signUp({ email: "user@test.com", password: "pass123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/signup");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "user@test.com",
      password: "pass123",
    });
  });

  it("returns { data: { user, access_token, refresh_token }, error: null } on success", async () => {
    vi.stubGlobal("fetch", mockFetchOk(MOCK_USER_AUTH_RESPONSE));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signUp({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toEqual(MOCK_USER_AUTH_RESPONSE);
    expect(result.error).toBeNull();
  });

  it("stores user tokens after successful signUp", async () => {
    const fetchMock = mockFetchOk(MOCK_USER_AUTH_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signUp({ email: "user@test.com", password: "pass123" });

    // Make another request — it should include the user Authorization header
    await client.auth.users.getUser();

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });

  it("returns { data: null, error } on failure", async () => {
    vi.stubGlobal("fetch", mockFetchError(409, "Email already registered"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signUp({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: "HTTP_409",
      message: "Email already registered",
    });
  });
});

describe("UserAuthClient.signIn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/login with email and password", async () => {
    const fetchMock = mockFetchOk(MOCK_USER_AUTH_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/login");
    expect(init.method).toBe("POST");
  });

  it("returns { data, error: null } on success", async () => {
    vi.stubGlobal("fetch", mockFetchOk(MOCK_USER_AUTH_RESPONSE));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signIn({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toEqual(MOCK_USER_AUTH_RESPONSE);
    expect(result.error).toBeNull();
  });

  it("stores user tokens after successful signIn", async () => {
    const fetchMock = mockFetchOk(MOCK_USER_AUTH_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    // Next request should include the Bearer token
    await client.auth.users.getUser();

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });

  it("returns error on invalid credentials", async () => {
    vi.stubGlobal("fetch", mockFetchError(401, "Invalid credentials"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signIn({
      email: "user@test.com",
      password: "wrong",
    });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_401");
  });
});

describe("UserAuthClient.signOut", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/logout with refresh token", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // signIn response
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // logout response
      return { ok: true, status: 200, json: async () => ({ message: "Logged out successfully" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.signOut();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/logout");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      refresh_token: "user-refresh-token",
    });
  });

  it("clears stored user tokens after signOut", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // logout + subsequent getUser
      return { ok: true, status: 200, json: async () => ({ message: "ok" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.signOut();

    // Next request should NOT include Authorization header
    await client.auth.users.getUser();

    const [, thirdInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const headers = thirdInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("returns { data, error: null } on success", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => ({ message: "Logged out successfully" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.signOut();

    expect(result.data).toEqual({ message: "Logged out successfully" });
    expect(result.error).toBeNull();
  });
});

describe("UserAuthClient.getUser", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls GET /v1/auth/users/me", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => MOCK_USER_PROFILE };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.getUser();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/me");
    expect(init.method).toBe("GET");
  });

  it("returns user profile data", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => MOCK_USER_PROFILE };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.getUser();

    expect(result.data).toEqual(MOCK_USER_PROFILE);
    expect(result.error).toBeNull();
  });

  it("sends Authorization header with user access token", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => MOCK_USER_PROFILE };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.getUser();

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });
});

describe("UserAuthClient.updateUser", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls PUT /v1/auth/users/me with metadata", async () => {
    const updatedProfile = { ...MOCK_USER_PROFILE, metadata: { name: "Test" } };
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => updatedProfile };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.updateUser({ metadata: { name: "Test" } });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/me");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ metadata: { name: "Test" } });
  });

  it("returns updated user profile", async () => {
    const updatedProfile = { ...MOCK_USER_PROFILE, metadata: { name: "Test" } };
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => updatedProfile };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.updateUser({ metadata: { name: "Test" } });

    expect(result.data).toEqual(updatedProfile);
    expect(result.error).toBeNull();
  });
});

describe("User auth token auto-refresh", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refreshes user token on 401 and retries the request", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      // 1: signIn — succeeds, stores user tokens
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // 2: getUser — 401 triggers refresh
      if (callCount === 2) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ detail: "Token expired" }),
        };
      }
      // 3: refresh endpoint
      if (callCount === 3) {
        expect(url).toContain("/v1/auth/users/refresh");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-user-access-token",
            token_type: "bearer",
          }),
        };
      }
      // 4: retry of getUser
      if (callCount === 4) {
        return { ok: true, status: 200, json: async () => MOCK_USER_PROFILE };
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    // This triggers 401 -> refresh -> retry
    const result = await client.auth.users.getUser();

    // signIn(1) + fail(2) + refresh(3) + retry(4)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.data).toEqual(MOCK_USER_PROFILE);

    // Verify the retry used the new access token
    const [, retryInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    const headers = retryInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer new-user-access-token");
  });

  it("returns error if user token refresh also fails", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      // 1: signIn succeeds
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // 2: getUser — 401
      if (callCount === 2) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ detail: "Token expired" }),
        };
      }
      // 3: refresh — also fails
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
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    const result = await client.auth.users.getUser();

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_401");
  });
});

describe("User auth and developer auth coexistence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("user auth state is separate from developer auth state", async () => {
    const DEVELOPER_TOKENS = {
      access_token: "developer-access-token",
      refresh_token: "developer-refresh-token",
      token_type: "bearer",
    };

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      // 1: developer signIn
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => DEVELOPER_TOKENS };
      }
      // 2: user signIn
      if (callCount === 2) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // 3: getUser (should use user token, not developer token)
      if (callCount === 3) {
        return { ok: true, status: 200, json: async () => MOCK_USER_PROFILE };
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");

    // Developer signs in first
    await client.auth.signIn({ email: "dev@test.com", password: "devpass" });

    // Then user signs in
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    // getUser should use user access token
    await client.auth.users.getUser();

    const [, thirdInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const headers = thirdInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });

  it("user signOut does not affect developer auth", async () => {
    const DEVELOPER_TOKENS = {
      access_token: "developer-access-token",
      refresh_token: "developer-refresh-token",
      token_type: "bearer",
    };

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      // 1: developer signIn
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => DEVELOPER_TOKENS };
      }
      // 2: user signIn
      if (callCount === 2) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // 3: user signOut
      if (callCount === 3) {
        return { ok: true, status: 200, json: async () => ({ message: "Logged out successfully" }) };
      }
      // 4: developer signIn again (should still have developer token from earlier)
      if (callCount === 4) {
        return { ok: true, status: 200, json: async () => DEVELOPER_TOKENS };
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");

    await client.auth.signIn({ email: "dev@test.com", password: "devpass" });
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.signOut();

    // Developer auth should still be intact — next developer request should have developer token
    await client.auth.signIn({ email: "dev@test.com", password: "devpass" });

    const [, fourthInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    const headers = fourthInit.headers as Record<string, string>;
    // Developer token should still be sent
    expect(headers["Authorization"]).toBe("Bearer developer-access-token");
  });
});

describe("User auth namespace access", () => {
  it("client.auth.users is accessible", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    expect(client.auth.users).toBeDefined();
    expect(typeof client.auth.users.signUp).toBe("function");
    expect(typeof client.auth.users.signIn).toBe("function");
    expect(typeof client.auth.users.signOut).toBe("function");
    expect(typeof client.auth.users.getUser).toBe("function");
    expect(typeof client.auth.users.updateUser).toBe("function");
  });
});
