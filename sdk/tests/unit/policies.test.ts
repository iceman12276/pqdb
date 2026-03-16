import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

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

const PROJECT_ID = "proj-uuid-123";

describe("PoliciesClient.create", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls POST /v1/db/tables/{name}/policies with policy data", async () => {
    const mockPolicy = {
      id: "policy-1",
      name: "users_read_own",
      operation: "SELECT",
      role: "authenticated",
      condition: "owner_id = auth.user_id()",
    };
    const fetchMock = mockFetchOk(mockPolicy);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key", {
      projectId: PROJECT_ID,
    });
    const result = await client.auth.policies.create("users", {
      name: "users_read_own",
      operation: "SELECT",
      role: "authenticated",
      condition: "owner_id = auth.user_id()",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/tables/users/policies");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "users_read_own",
      operation: "SELECT",
      role: "authenticated",
      condition: "owner_id = auth.user_id()",
    });
    expect(result.data).toEqual(mockPolicy);
    expect(result.error).toBeNull();
  });

  it("returns { data: null, error } on failure", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "Invalid operation"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key", {
      projectId: PROJECT_ID,
    });
    const result = await client.auth.policies.create("users", {
      name: "bad_policy",
      operation: "INVALID",
      role: "authenticated",
      condition: "true",
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: "HTTP_400",
      message: "Invalid operation",
    });
  });
});

describe("PoliciesClient.list", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls GET /v1/db/tables/{name}/policies", async () => {
    const mockPolicies = [
      {
        id: "policy-1",
        name: "users_read_own",
        operation: "SELECT",
        role: "authenticated",
        condition: "owner_id = auth.user_id()",
      },
    ];
    const fetchMock = mockFetchOk(mockPolicies);
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key", {
      projectId: PROJECT_ID,
    });
    const result = await client.auth.policies.list("users");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/db/tables/users/policies");
    expect(init.method).toBe("GET");
    expect(result.data).toEqual(mockPolicies);
    expect(result.error).toBeNull();
  });
});

describe("PoliciesClient.delete", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls DELETE /v1/db/tables/{name}/policies/{id}", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: async () => {
        throw new Error("No body");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient("http://localhost:3000", "pqdb_anon_key", {
      projectId: PROJECT_ID,
    });
    await client.auth.policies.delete("users", "policy-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://localhost:3000/v1/db/tables/users/policies/policy-1"
    );
    expect(init.method).toBe("DELETE");
  });

  it("returns error when policy not found", async () => {
    vi.stubGlobal("fetch", mockFetchError(404, "Policy not found"));

    const client = createClient("http://localhost:3000", "pqdb_anon_key", {
      projectId: PROJECT_ID,
    });
    const result = await client.auth.policies.delete("users", "nonexistent");

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("HTTP_404");
  });
});

describe("Policies namespace access", () => {
  it("client.auth.policies is accessible", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_key", {
      projectId: PROJECT_ID,
    });
    expect(client.auth.policies).toBeDefined();
    expect(typeof client.auth.policies.create).toBe("function");
    expect(typeof client.auth.policies.list).toBe("function");
    expect(typeof client.auth.policies.delete).toBe("function");
  });
});
