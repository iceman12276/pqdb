import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { fetch: mockApiFetch },
}));

import { createTable } from "~/lib/table-data";

describe("createTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls POST /v1/db/tables with correct payload", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { name: "users", columns: [] },
    });

    await createTable(
      "pqdb_service_abc",
      "users",
      [
        { name: "id", data_type: "uuid", sensitivity: "plain", is_owner: true },
        { name: "email", data_type: "text", sensitivity: "searchable", is_owner: false },
      ],
    );

    expect(mockApiFetch).toHaveBeenCalledWith("/v1/db/tables", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: "pqdb_service_abc",
      },
      body: JSON.stringify({
        name: "users",
        columns: [
          { name: "id", data_type: "uuid", sensitivity: "plain", owner: true },
          { name: "email", data_type: "text", sensitivity: "searchable", owner: false },
        ],
      }),
    });
  });

  it("returns the created table on success", async () => {
    const tableData = {
      name: "users",
      columns: [
        { name: "id", data_type: "uuid", sensitivity: "plain", is_owner: true },
      ],
    };
    mockApiFetch.mockResolvedValueOnce({ ok: true, status: 201, data: tableData });

    const result = await createTable("key", "users", [
      { name: "id", data_type: "uuid", sensitivity: "plain", is_owner: true },
    ]);

    expect(result).toEqual(tableData);
  });

  it("throws with error message on failure", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { error: { code: "CONFLICT", message: "Table already exists" } },
    });

    await expect(
      createTable("key", "users", [
        { name: "id", data_type: "uuid", sensitivity: "plain", is_owner: false },
      ]),
    ).rejects.toThrow("Failed to create table");
  });
});
