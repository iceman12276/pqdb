import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchExtensions } = vi.hoisted(() => ({
  mockFetchExtensions: vi.fn(),
}));

vi.mock("~/lib/introspection", () => ({
  fetchExtensions: mockFetchExtensions,
}));

import { ExtensionsPage } from "~/components/extensions-page";
import type { Extension } from "~/lib/introspection";

const mockExtensions: Extension[] = [
  {
    name: "pgcrypto",
    version: "1.3",
    schema: "public",
    comment: "cryptographic functions",
  },
  {
    name: "vector",
    version: "0.7.0",
    schema: "public",
    comment: "vector data type and ivfflat and hnsw access methods",
  },
  {
    name: "plpgsql",
    version: "1.0",
    schema: "pg_catalog",
    comment: null,
  },
];

describe("ExtensionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchExtensions.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("extensions-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchExtensions.mockRejectedValueOnce(new Error("Failed to fetch extensions"));
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/failed to fetch extensions/i)).toBeInTheDocument();
  });

  it("shows empty state when no extensions exist", async () => {
    mockFetchExtensions.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/no extensions/i)).toBeInTheDocument();
  });

  it("renders extension list with names", async () => {
    mockFetchExtensions.mockResolvedValueOnce(mockExtensions);
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("pgcrypto")).toBeInTheDocument();
    expect(screen.getByText("vector")).toBeInTheDocument();
    expect(screen.getByText("plpgsql")).toBeInTheDocument();
  });

  it("shows version for each extension", async () => {
    mockFetchExtensions.mockResolvedValueOnce(mockExtensions);
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pgcrypto")).toBeInTheDocument();
    });
    expect(screen.getByText("1.3")).toBeInTheDocument();
    expect(screen.getByText("0.7.0")).toBeInTheDocument();
    expect(screen.getByText("1.0")).toBeInTheDocument();
  });

  it("shows schema for each extension", async () => {
    mockFetchExtensions.mockResolvedValueOnce(mockExtensions);
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pgcrypto")).toBeInTheDocument();
    });
    // "public" appears for pgcrypto and vector
    const publicLabels = screen.getAllByText("public");
    expect(publicLabels.length).toBeGreaterThanOrEqual(2);
  });

  it("shows description when comment is present", async () => {
    mockFetchExtensions.mockResolvedValueOnce(mockExtensions);
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pgcrypto")).toBeInTheDocument();
    });
    expect(screen.getByText("cryptographic functions")).toBeInTheDocument();
    expect(screen.getByText("vector data type and ivfflat and hnsw access methods")).toBeInTheDocument();
  });

  it("handles null comment gracefully", async () => {
    mockFetchExtensions.mockResolvedValueOnce([
      { name: "plpgsql", version: "1.0", schema: "pg_catalog", comment: null },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<ExtensionsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("plpgsql")).toBeInTheDocument();
    });
    // Should not crash, and the extension card should be present
    expect(screen.getByText("1.0")).toBeInTheDocument();
  });
});
