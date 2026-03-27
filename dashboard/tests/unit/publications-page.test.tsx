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
const mockFetchPublications = vi.hoisted(() => vi.fn());

vi.mock("~/lib/introspection", () => ({
  fetchPublications: mockFetchPublications,
}));

import { PublicationsPage } from "~/components/publications-page";

describe("PublicationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page title", async () => {
    mockFetchPublications.mockResolvedValue([]);
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });
    expect(screen.getByText("Publications")).toBeInTheDocument();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchPublications.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });
    expect(screen.getByTestId("publications-loading")).toBeInTheDocument();
  });

  it("shows empty state when no publications", async () => {
    mockFetchPublications.mockResolvedValue([]);
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("publications-empty")).toBeInTheDocument();
    });
    expect(screen.getByTestId("publications-empty")).toHaveTextContent(
      "No publications found",
    );
  });

  it("renders publication rows with name and tables", async () => {
    mockFetchPublications.mockResolvedValue([
      {
        name: "my_pub",
        all_tables: false,
        insert: true,
        update: true,
        delete: false,
        tables: ["users", "orders"],
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("my_pub")).toBeInTheDocument();
    });
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("shows ALL TABLES badge when all_tables is true", async () => {
    mockFetchPublications.mockResolvedValue([
      {
        name: "all_pub",
        all_tables: true,
        insert: true,
        update: true,
        delete: true,
        tables: [],
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("ALL TABLES")).toBeInTheDocument();
    });
  });

  it("shows enabled operations as badges", async () => {
    mockFetchPublications.mockResolvedValue([
      {
        name: "my_pub",
        all_tables: false,
        insert: true,
        update: true,
        delete: false,
        tables: ["users"],
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("INSERT")).toBeInTheDocument();
    });
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
    // DELETE should not be shown since it's false
    expect(screen.queryByText("DELETE")).not.toBeInTheDocument();
  });

  it("shows all operations when all enabled", async () => {
    mockFetchPublications.mockResolvedValue([
      {
        name: "full_pub",
        all_tables: true,
        insert: true,
        update: true,
        delete: true,
        tables: [],
      },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("INSERT")).toBeInTheDocument();
    });
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
    expect(screen.getByText("DELETE")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchPublications.mockRejectedValue(new Error("Network error"));
    const { wrapper } = createQueryWrapper();
    render(<PublicationsPage projectId="proj-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("publications-error")).toBeInTheDocument();
    });
  });
});
