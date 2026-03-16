import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

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

/** Helper: sign in first, then run callback with the sequential fetch mock. */
function withSignedInUser(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let callCount = 0;
  const allResponses = [
    { ok: true, status: 200, body: MOCK_USER_AUTH_RESPONSE },
    ...responses,
  ];

  const fetchMock = vi.fn().mockImplementation(async () => {
    const resp = allResponses[callCount] ?? allResponses[allResponses.length - 1];
    callCount++;
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.ok ? "OK" : "Error",
      json: async () => resp.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── OAuth ──────────────────────────────────────────────────────────────

describe("UserAuthClient.signInWithOAuth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns authorization URL with provider and redirectTo", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signInWithOAuth("google", {
      redirectTo: "http://localhost:8080/callback",
    });

    expect(result.data).toEqual({
      url: "http://localhost:3000/v1/auth/users/oauth/google/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback",
      provider: "google",
    });
    expect(result.error).toBeNull();
  });

  it("works with different providers", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signInWithOAuth("github", {
      redirectTo: "http://myapp.com/auth",
    });

    expect(result.data!.url).toContain("/oauth/github/authorize");
    expect(result.data!.provider).toBe("github");
  });

  it("encodes redirectTo URL properly", async () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signInWithOAuth("google", {
      redirectTo: "http://localhost:8080/callback?foo=bar&baz=1",
    });

    expect(result.data!.url).toContain(
      "redirect_uri=" + encodeURIComponent("http://localhost:8080/callback?foo=bar&baz=1"),
    );
  });
});

describe("UserAuthClient.handleOAuthCallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts tokens from params and stores them", async () => {
    const fetchMock = mockFetchOk({ id: "user-uuid-123", email: "user@test.com", role: "authenticated", email_verified: true, metadata: {} });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.handleOAuthCallback({
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
      token_type: "bearer",
    });

    expect(result.data).toEqual({
      user: { id: "user-uuid-123", email: "user@test.com", role: "authenticated", email_verified: true, metadata: {} },
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
    });
    expect(result.error).toBeNull();

    // Verify tokens are stored — next request should use the OAuth access token
    await client.auth.users.getUser();
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer oauth-access-token");
  });

  it("returns error if getUser fails after storing tokens", async () => {
    vi.stubGlobal("fetch", mockFetchError(401, "Invalid token"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.handleOAuthCallback({
      access_token: "bad-token",
      refresh_token: "bad-refresh",
    });

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
  });
});

describe("UserAuthClient.linkOAuth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns authorization URL for linking when authenticated", async () => {
    const fetchMock = withSignedInUser([
      { ok: true, status: 200, body: { url: "http://localhost:3000/v1/auth/users/oauth/github/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Flink&link=true", provider: "github" } },
    ]);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.linkOAuth("github", {
      redirectTo: "http://localhost:8080/link",
    });

    expect(result.data).toEqual({
      url: "http://localhost:3000/v1/auth/users/oauth/github/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Flink&link=true",
      provider: "github",
    });
    expect(result.error).toBeNull();

    // Verify it called the correct endpoint with auth header
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/oauth/github/link");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });
});

describe("UserAuthClient.unlinkOAuth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls DELETE /v1/auth/users/oauth/{provider}", async () => {
    const fetchMock = withSignedInUser([
      { ok: true, status: 200, body: { message: "Provider unlinked" } },
    ]);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.unlinkOAuth("github");

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ message: "Provider unlinked" });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/oauth/github");
    expect(init.method).toBe("DELETE");
  });

  it("returns error when not authenticated", async () => {
    vi.stubGlobal("fetch", mockFetchError(401, "Not authenticated"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.unlinkOAuth("github");

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_401");
  });
});

describe("UserAuthClient.getLinkedProviders", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls GET /v1/auth/users/oauth/providers", async () => {
    const providers = [
      { provider: "google", provider_user_id: "g-123", email: "user@gmail.com", linked_at: "2026-01-01T00:00:00Z" },
      { provider: "github", provider_user_id: "gh-456", email: "user@github.com", linked_at: "2026-02-01T00:00:00Z" },
    ];

    const fetchMock = withSignedInUser([
      { ok: true, status: 200, body: providers },
    ]);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.getLinkedProviders();

    expect(result.data).toEqual(providers);
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/oauth/providers");
    expect(init.method).toBe("GET");
  });
});

// ── Magic Link ─────────────────────────────────────────────────────────

describe("UserAuthClient.signInWithMagicLink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/magic-link with email", async () => {
    const fetchMock = mockFetchOk({ message: "Magic link sent" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signInWithMagicLink({ email: "user@test.com" });

    expect(result.data).toEqual({ message: "Magic link sent" });
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/magic-link");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "user@test.com" });
  });

  it("returns error for invalid email", async () => {
    vi.stubGlobal("fetch", mockFetchError(422, "Invalid email format"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signInWithMagicLink({ email: "not-an-email" });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_422");
  });
});

describe("UserAuthClient.verifyMagicLink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/verify-magic-link and stores tokens", async () => {
    const fetchMock = mockFetchOk(MOCK_USER_AUTH_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.verifyMagicLink("magic-token-abc");

    expect(result.data).toEqual(MOCK_USER_AUTH_RESPONSE);
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/verify-magic-link");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "magic-token-abc" });

    // Verify tokens are stored — next request should use them
    await client.auth.users.getUser();
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });

  it("returns error for invalid token", async () => {
    vi.stubGlobal("fetch", mockFetchError(401, "Invalid or expired token"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.verifyMagicLink("bad-token");

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_401");
  });
});

// ── Email Verification ─────────────────────────────────────────────────

describe("UserAuthClient.verifyEmail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/verify-email with token", async () => {
    const fetchMock = mockFetchOk({ message: "Email verified" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.verifyEmail("verification-token-xyz");

    expect(result.data).toEqual({ message: "Email verified" });
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/verify-email");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "verification-token-xyz" });
  });

  it("returns error for invalid verification token", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "Invalid verification token"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.verifyEmail("bad-token");

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_400");
  });
});

describe("UserAuthClient.resendVerification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/resend-verification with auth header", async () => {
    const fetchMock = withSignedInUser([
      { ok: true, status: 200, body: { message: "Verification email sent" } },
    ]);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.resendVerification();

    expect(result.data).toEqual({ message: "Verification email sent" });
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/resend-verification");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });
});

// ── Password Reset ─────────────────────────────────────────────────────

describe("UserAuthClient.resetPassword", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/reset-password with email", async () => {
    const fetchMock = mockFetchOk({ message: "Password reset email sent" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.resetPassword({ email: "user@test.com" });

    expect(result.data).toEqual({ message: "Password reset email sent" });
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/reset-password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "user@test.com" });
  });

  it("returns error for unknown email", async () => {
    vi.stubGlobal("fetch", mockFetchError(404, "Email not found"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.resetPassword({ email: "unknown@test.com" });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_404");
  });
});

describe("UserAuthClient.updatePassword", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/update-password with token and newPassword", async () => {
    const fetchMock = mockFetchOk({ message: "Password updated" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.updatePassword({
      token: "reset-token-abc",
      newPassword: "new-secure-password",
    });

    expect(result.data).toEqual({ message: "Password updated" });
    expect(result.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/update-password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      token: "reset-token-abc",
      new_password: "new-secure-password",
    });
  });

  it("returns error for invalid reset token", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "Invalid or expired reset token"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.updatePassword({
      token: "bad-token",
      newPassword: "new-password",
    });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_400");
  });
});

// ── Method existence ───────────────────────────────────────────────────

describe("OAuth + magic link + verification method namespace", () => {
  it("all new methods are accessible on client.auth.users", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    expect(typeof client.auth.users.signInWithOAuth).toBe("function");
    expect(typeof client.auth.users.handleOAuthCallback).toBe("function");
    expect(typeof client.auth.users.linkOAuth).toBe("function");
    expect(typeof client.auth.users.unlinkOAuth).toBe("function");
    expect(typeof client.auth.users.getLinkedProviders).toBe("function");
    expect(typeof client.auth.users.signInWithMagicLink).toBe("function");
    expect(typeof client.auth.users.verifyMagicLink).toBe("function");
    expect(typeof client.auth.users.verifyEmail).toBe("function");
    expect(typeof client.auth.users.resendVerification).toBe("function");
    expect(typeof client.auth.users.resetPassword).toBe("function");
    expect(typeof client.auth.users.updatePassword).toBe("function");
  });
});
