import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchTables } = vi.hoisted(() => ({
  mockFetchTables: vi.fn(),
}));

vi.mock("~/lib/table-data", () => ({
  fetchTables: mockFetchTables,
  fetchTableRows: vi.fn().mockResolvedValue([]),
  insertRow: vi.fn().mockResolvedValue([]),
  deleteRow: vi.fn().mockResolvedValue([]),
  fetchRowCount: vi.fn().mockResolvedValue(0),
}));

import { TableListPage } from "~/components/table-list-page";

const mockTablesData = [
  {
    name: "users",
    columns: [
      { name: "id", data_type: "uuid", sensitivity: "plain", is_owner: true },
      { name: "email", data_type: "text", sensitivity: "searchable", is_owner: false },
      { name: "ssn", data_type: "text", sensitivity: "private", is_owner: false },
      { name: "name", data_type: "text", sensitivity: "plain", is_owner: false },
    ],
  },
  {
    name: "posts",
    columns: [
      { name: "id", data_type: "uuid", sensitivity: "plain", is_owner: false },
      { name: "user_id", data_type: "uuid", sensitivity: "plain", is_owner: true },
      { name: "title", data_type: "text", sensitivity: "plain", is_owner: false },
    ],
  },
];

describe("TableListPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching tables", () => {
    mockFetchTables.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<TableListPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(screen.getByTestId("table-list-loading")).toBeInTheDocument();
  });

  it("shows empty state when no tables exist", async () => {
    mockFetchTables.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<TableListPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(await screen.findByText(/no tables/i)).toBeInTheDocument();
  });

  it("renders table list with names", async () => {
    mockFetchTables.mockResolvedValueOnce(mockTablesData);
    const { wrapper } = createQueryWrapper();
    render(<TableListPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("posts")).toBeInTheDocument();
  });

  it("shows column count for each table", async () => {
    mockFetchTables.mockResolvedValueOnce(mockTablesData);
    const { wrapper } = createQueryWrapper();
    render(<TableListPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });
    expect(screen.getByText(/4 columns/i)).toBeInTheDocument();
    expect(screen.getByText(/3 columns/i)).toBeInTheDocument();
  });
});
