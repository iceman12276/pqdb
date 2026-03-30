import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchMigrations } = vi.hoisted(() => ({
  mockFetchMigrations: vi.fn(),
}));

vi.mock("~/lib/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/projects")>();
  return {
    ...actual,
    fetchMigrations: mockFetchMigrations,
  };
});

import { MigrationsPage } from "~/components/migrations-page";
import type { MigrationListResponse } from "~/lib/projects";

const mockData: MigrationListResponse = {
  current_head: "003",
  migrations: [
    {
      revision: "001",
      down_revision: null,
      description: "Create developers table.",
      applied: true,
    },
    {
      revision: "002",
      down_revision: "001",
      description: "Create projects table.",
      applied: true,
    },
    {
      revision: "003",
      down_revision: "002",
      description: "Create API keys table.",
      applied: true,
    },
  ],
};

describe("MigrationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchMigrations.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });
    // Skeletons are rendered during loading
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchMigrations.mockRejectedValueOnce(
      new Error("Failed to fetch migrations"),
    );
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });
    expect(
      await screen.findByText(/failed to fetch migrations/i),
    ).toBeInTheDocument();
  });

  it("shows empty state when no migrations exist", async () => {
    mockFetchMigrations.mockResolvedValueOnce({
      current_head: null,
      migrations: [],
    });
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });
    expect(
      await screen.findByText(/no migrations found/i),
    ).toBeInTheDocument();
  });

  it("renders migration list with revision numbers", async () => {
    mockFetchMigrations.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    expect(await screen.findByText("001")).toBeInTheDocument();
    expect(screen.getByText("002")).toBeInTheDocument();
    // "003" appears in both header and migration item
    const items003 = screen.getAllByText("003");
    expect(items003.length).toBeGreaterThanOrEqual(1);
  });

  it("renders migration descriptions", async () => {
    mockFetchMigrations.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    expect(
      await screen.findByText("Create developers table."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Create projects table."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Create API keys table."),
    ).toBeInTheDocument();
  });

  it("shows HEAD badge on current head migration", async () => {
    mockFetchMigrations.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    expect(
      await screen.findByTestId("current-head-badge"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("current-head-badge")).toHaveTextContent(
      "HEAD",
    );
  });

  it("shows applied check icons for applied migrations", async () => {
    mockFetchMigrations.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      const appliedIcons = screen.getAllByTestId("migration-applied");
      expect(appliedIcons).toHaveLength(3);
    });
  });

  it("shows pending icon for unapplied migrations", async () => {
    const dataWithPending: MigrationListResponse = {
      current_head: "001",
      migrations: [
        {
          revision: "001",
          down_revision: null,
          description: "First migration.",
          applied: true,
        },
        {
          revision: "002",
          down_revision: "001",
          description: "Second migration.",
          applied: false,
        },
      ],
    };
    mockFetchMigrations.mockResolvedValueOnce(dataWithPending);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("migration-pending")).toBeInTheDocument();
    });
  });

  it("shows current head in header", async () => {
    mockFetchMigrations.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current head/i)).toBeInTheDocument();
    });
    // "003" appears in both header code element and migration item
    const items003 = screen.getAllByText("003");
    expect(items003.length).toBeGreaterThanOrEqual(2);
  });

  it("renders migration items with correct test ids", async () => {
    mockFetchMigrations.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<MigrationsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      const items = screen.getAllByTestId("migration-item");
      expect(items).toHaveLength(3);
    });
  });
});
