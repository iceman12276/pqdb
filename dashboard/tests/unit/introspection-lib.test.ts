import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { fetch: mockApiFetch },
}));

import { fetchFunctions, fetchTriggers } from "~/lib/introspection";

describe("fetchFunctions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls GET /v1/db/catalog/functions with apikey header", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      data: [{ name: "my_func", schema: "public", args: "", return_type: "void", language: "sql", source: "" }],
    });
    const result = await fetchFunctions("pqdb_service_abc");
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/db/catalog/functions", {
      headers: { apikey: "pqdb_service_abc" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my_func");
  });

  it("throws on non-ok response", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 500, data: null });
    await expect(fetchFunctions("key")).rejects.toThrow("Failed to fetch functions");
  });
});

describe("fetchTriggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls GET /v1/db/catalog/triggers with apikey header", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      data: [{ name: "my_trig", table: "users", timing: "AFTER", events: ["INSERT"], function_name: "fn" }],
    });
    const result = await fetchTriggers("pqdb_service_abc");
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/db/catalog/triggers", {
      headers: { apikey: "pqdb_service_abc" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my_trig");
  });

  it("throws on non-ok response", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 500, data: null });
    await expect(fetchTriggers("key")).rejects.toThrow("Failed to fetch triggers");
  });
});
