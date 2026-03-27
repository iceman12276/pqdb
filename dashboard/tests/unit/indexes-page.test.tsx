import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

// Mock project context
const mockUseProjectContext = vi.hoisted(() =>
  vi.fn(() => ({
    project: { id: "proj-1", name: "Test Project" },
    apiKey: "pqdb_service_testkey123",
    loading: false,
    error: null,
  })),
);

vi.mock("~/lib/project-context", () => ({
  useProjectContext: mockUseProjectContext,
}));

// Mock introspection fetch
const mockFetchIndexes = vi.hoisted(() => vi.fn());

vi.mock("~/lib/introspection", () => ({
  fetchIndexes: mockFetchIndexes,
}));

import { IndexesPage } from "~/components/indexes-page";

describe("IndexesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page title", async () => {
    mockFetchIndexes.mockResolvedValue([]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });
    expect(screen.getByText("Indexes")).toBeInTheDocument();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchIndexes.mockReturnValue(new Promise(() => {})); // never resolves
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });
    expect(screen.getByTestId("indexes-loading")).toBeInTheDocument();
  });

  it("shows empty state when no indexes", async () => {
    mockFetchIndexes.mockResolvedValue([]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("indexes-empty")).toBeInTheDocument();
    });
    expect(screen.getByTestId("indexes-empty")).toHaveTextContent(
      "No indexes found",
    );
  });

  it("renders index rows with name, table, unique badge", async () => {
    mockFetchIndexes.mockResolvedValue([
      {
        name: "users_pkey",
        table: "users",
        definition:
          "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
        unique: true,
        size_bytes: 16384,
      },
      {
        name: "orders_user_id_idx",
        table: "orders",
        definition:
          "CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)",
        unique: false,
        size_bytes: 8192,
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getAllByTestId("index-row")).toHaveLength(2);
    });

    const rows = screen.getAllByTestId("index-row");
    expect(rows[0]).toHaveTextContent("users_pkey");
    expect(rows[0]).toHaveTextContent("users");
    expect(rows[1]).toHaveTextContent("orders_user_id_idx");
    expect(rows[1]).toHaveTextContent("orders");
  });

  it("shows unique badge for unique indexes", async () => {
    mockFetchIndexes.mockResolvedValue([
      {
        name: "users_pkey",
        table: "users",
        definition:
          "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
        unique: true,
        size_bytes: 16384,
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getAllByTestId("index-row")).toHaveLength(1);
    });
    const row = screen.getAllByTestId("index-row")[0];
    expect(row).toHaveTextContent("Unique");
  });

  it("extracts and displays index type from definition", async () => {
    mockFetchIndexes.mockResolvedValue([
      {
        name: "users_pkey",
        table: "users",
        definition:
          "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
        unique: true,
        size_bytes: 16384,
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("btree")).toBeInTheDocument();
    });
  });

  it("extracts and displays columns from definition", async () => {
    mockFetchIndexes.mockResolvedValue([
      {
        name: "orders_composite_idx",
        table: "orders",
        definition:
          "CREATE INDEX orders_composite_idx ON public.orders USING btree (user_id, created_at)",
        unique: false,
        size_bytes: 8192,
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByText("user_id, created_at"),
      ).toBeInTheDocument();
    });
  });

  it("displays formatted size", async () => {
    mockFetchIndexes.mockResolvedValue([
      {
        name: "users_pkey",
        table: "users",
        definition:
          "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
        unique: true,
        size_bytes: 16384,
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("16 kB")).toBeInTheDocument();
    });
  });

  it("shows full definition in detail area", async () => {
    const definition =
      "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)";
    mockFetchIndexes.mockResolvedValue([
      {
        name: "users_pkey",
        table: "users",
        definition,
        unique: true,
        size_bytes: 16384,
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText(definition)).toBeInTheDocument();
    });
  });

  it("shows error state on fetch failure", async () => {
    mockFetchIndexes.mockRejectedValue(new Error("Network error"));
    const { wrapper } = createQueryWrapper();
    render(<IndexesPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("indexes-error")).toBeInTheDocument();
    });
  });
});
