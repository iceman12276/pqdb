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

describe("MfaClient.enroll", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/mfa/enroll", async () => {
    const enrollResponse = {
      secret: "JBSWY3DPEHPK3PXP",
      qr_uri: "otpauth://totp/pqdb:user@test.com?secret=JBSWY3DPEHPK3PXP",
      recovery_codes: ["code1", "code2", "code3"],
    };

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => enrollResponse };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.mfa.enroll();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/mfa/enroll");
    expect(init.method).toBe("POST");
    expect(result.data).toEqual(enrollResponse);
    expect(result.error).toBeNull();
  });

  it("sends user Authorization header", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ secret: "s", qr_uri: "u", recovery_codes: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    await client.auth.users.mfa.enroll();

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-access-token");
  });

  it("returns error on failure", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return {
        ok: false,
        status: 400,
        statusText: "Error",
        json: async () => ({ detail: "MFA already enrolled" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.mfa.enroll();

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_400");
  });
});

describe("MfaClient.verify", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/mfa/verify with code", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => ({ verified: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.mfa.verify({ code: "123456" });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/mfa/verify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "123456" });
    expect(result.data).toEqual({ verified: true });
    expect(result.error).toBeNull();
  });
});

describe("MfaClient.challenge", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/mfa/challenge with ticket and code, stores tokens", async () => {
    const mfaTokenResponse = {
      access_token: "mfa-access-token",
      refresh_token: "mfa-refresh-token",
      token_type: "bearer",
      user: {
        id: "user-uuid-123",
        email: "user@test.com",
        role: "authenticated",
        email_verified: true,
        metadata: {},
      },
    };

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Initial signIn returns MFA required
        return {
          ok: true,
          status: 200,
          json: async () => ({ mfa_required: true, mfa_ticket: "mfa-ticket-abc" }),
        };
      }
      if (callCount === 2) {
        // MFA challenge succeeds
        return { ok: true, status: 200, json: async () => mfaTokenResponse };
      }
      // Subsequent request to verify tokens are stored
      return { ok: true, status: 200, json: async () => ({ id: "user-uuid-123" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");

    // signIn returns MFA required
    const signInResult = await client.auth.users.signIn({
      email: "user@test.com",
      password: "pass123",
    });
    expect(signInResult.data).toEqual({
      mfa_required: true,
      mfa_ticket: "mfa-ticket-abc",
    });

    // Complete MFA challenge
    const result = await client.auth.users.mfa.challenge({
      ticket: "mfa-ticket-abc",
      code: "123456",
    });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/mfa/challenge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      ticket: "mfa-ticket-abc",
      code: "123456",
    });
    expect(result.data).toEqual(mfaTokenResponse);
    expect(result.error).toBeNull();

    // Verify tokens were stored — next request should use the MFA access token
    await client.auth.users.getUser();
    const [, thirdInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const headers = thirdInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer mfa-access-token");
  });
});

describe("MfaClient.unenroll", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/auth/users/mfa/unenroll with code", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => ({ unenrolled: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });
    const result = await client.auth.users.mfa.unenroll({ code: "123456" });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/mfa/unenroll");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "123456" });
    expect(result.data).toEqual({ unenrolled: true });
    expect(result.error).toBeNull();
  });
});

describe("UserAuthClient.setRole", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls PUT /v1/auth/users/{userId}/role with role", async () => {
    const fetchMock = mockFetchOk({ role: "editor" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_service_key");
    const result = await client.auth.users.setRole("user-uuid-123", "editor");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/auth/users/user-uuid-123/role");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ role: "editor" });
    expect(result.data).toEqual({ role: "editor" });
    expect(result.error).toBeNull();
  });

  it("returns error when unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchError(403, "Service API key required")
    );

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.setRole("user-uuid-123", "editor");

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_403");
  });
});

describe("Modified signIn flow — MFA required", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns { data: { mfa_required, mfa_ticket }, error: null } when MFA is required", async () => {
    const mfaResponse = {
      mfa_required: true,
      mfa_ticket: "mfa-ticket-xyz",
    };
    vi.stubGlobal("fetch", mockFetchOk(mfaResponse));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signIn({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toEqual({
      mfa_required: true,
      mfa_ticket: "mfa-ticket-xyz",
    });
    expect(result.error).toBeNull();
  });

  it("does not store tokens when MFA is required", async () => {
    const mfaResponse = {
      mfa_required: true,
      mfa_ticket: "mfa-ticket-xyz",
    };
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => mfaResponse };
      }
      // getUser should not have Authorization header
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    // Attempt to get user — should not have user auth token
    await client.auth.users.getUser();

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("normal signIn still works when MFA is not required", async () => {
    vi.stubGlobal("fetch", mockFetchOk(MOCK_USER_AUTH_RESPONSE));

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    const result = await client.auth.users.signIn({
      email: "user@test.com",
      password: "pass123",
    });

    expect(result.data).toEqual(MOCK_USER_AUTH_RESPONSE);
    expect(result.error).toBeNull();
  });
});

describe("MFA namespace access", () => {
  it("client.auth.users.mfa is accessible", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    expect(client.auth.users.mfa).toBeDefined();
    expect(typeof client.auth.users.mfa.enroll).toBe("function");
    expect(typeof client.auth.users.mfa.verify).toBe("function");
    expect(typeof client.auth.users.mfa.challenge).toBe("function");
    expect(typeof client.auth.users.mfa.unenroll).toBe("function");
  });
});
