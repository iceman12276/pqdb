import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: {
    fetch: mockApiFetch,
  },
}));

import { executeQuery, buildQueryPayload } from "~/lib/query";

describe("buildQueryPayload", () => {
  it("builds payload with defaults (all columns, no filters)", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: [],
      filters: [],
    });
    expect(payload).toEqual({
      columns: ["*"],
      filters: [],
      modifiers: {},
    });
  });

  it("builds payload with selected columns", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: ["id", "name", "email"],
      filters: [],
    });
    expect(payload).toEqual({
      columns: ["id", "name", "email"],
      filters: [],
      modifiers: {},
    });
  });

  it("builds payload with filters", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: [],
      filters: [
        { column: "name", op: "eq", value: "Alice" },
        { column: "id", op: "gt", value: "5" },
      ],
    });
    expect(payload).toEqual({
      columns: ["*"],
      filters: [
        { column: "name", op: "eq", value: "Alice" },
        { column: "id", op: "gt", value: "5" },
      ],
      modifiers: {},
    });
  });

  it("builds payload with limit and offset", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: [],
      filters: [],
      limit: 10,
      offset: 20,
    });
    expect(payload).toEqual({
      columns: ["*"],
      filters: [],
      modifiers: { limit: 10, offset: 20 },
    });
  });

  it("builds payload with order_by and order_dir", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: [],
      filters: [],
      orderBy: "name",
      orderDir: "desc",
    });
    expect(payload).toEqual({
      columns: ["*"],
      filters: [],
      modifiers: { order_by: "name", order_dir: "desc" },
    });
  });

  it("builds full payload with all options", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: ["id", "name"],
      filters: [{ column: "name", op: "eq", value: "Bob" }],
      limit: 5,
      offset: 0,
      orderBy: "id",
      orderDir: "asc",
    });
    expect(payload).toEqual({
      columns: ["id", "name"],
      filters: [{ column: "name", op: "eq", value: "Bob" }],
      modifiers: {
        limit: 5,
        offset: 0,
        order_by: "id",
        order_dir: "asc",
      },
    });
  });

  it("omits undefined modifiers from payload", () => {
    const payload = buildQueryPayload({
      table: "users",
      columns: [],
      filters: [],
      limit: 10,
    });
    expect(payload.modifiers).toEqual({ limit: 10 });
    expect("offset" in payload.modifiers).toBe(false);
    expect("order_by" in payload.modifiers).toBe(false);
  });
});

describe("executeQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends POST request to correct endpoint with payload", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: [{ id: "1", name: "Alice" }] },
    });

    const result = await executeQuery("users", {
      columns: ["*"],
      filters: [],
      modifiers: {},
    }, "pqdb_anon_abc");

    expect(mockApiFetch).toHaveBeenCalledWith("/v1/db/users/select", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: "pqdb_anon_abc",
      },
      body: JSON.stringify({
        columns: ["*"],
        filters: [],
        modifiers: {},
      }),
    });
    expect(result).toEqual({ data: [{ id: "1", name: "Alice" }] });
  });

  it("returns error on failed request", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      data: { detail: "Table 'foo' not found" },
    });

    const result = await executeQuery("foo", {
      columns: ["*"],
      filters: [],
      modifiers: {},
    }, "pqdb_anon_abc");

    expect(result).toEqual({ error: "Table 'foo' not found" });
  });

  it("returns error on network failure", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await executeQuery("users", {
      columns: ["*"],
      filters: [],
      modifiers: {},
    }, "pqdb_anon_abc");

    expect(result).toEqual({ error: "Network error" });
  });

  it("handles error response with error.message format", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      data: { error: { message: "Invalid filter op" } },
    });

    const result = await executeQuery("users", {
      columns: ["*"],
      filters: [{ column: "id", op: "invalid", value: "1" }],
      modifiers: {},
    }, "pqdb_anon_abc");

    expect(result).toEqual({ error: "Invalid filter op" });
  });
});
