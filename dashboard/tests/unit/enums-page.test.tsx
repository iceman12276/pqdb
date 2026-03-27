import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchEnums } = vi.hoisted(() => ({
  mockFetchEnums: vi.fn(),
}));

vi.mock("~/lib/introspection", () => ({
  fetchEnums: mockFetchEnums,
}));

import { EnumsPage } from "~/components/enums-page";
import type { EnumType } from "~/lib/introspection";

const mockEnums: EnumType[] = [
  {
    name: "mood",
    schema: "public",
    values: ["happy", "sad", "neutral"],
  },
  {
    name: "status",
    schema: "public",
    values: ["active", "inactive", "pending"],
  },
];

describe("EnumsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchEnums.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("enums-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchEnums.mockRejectedValueOnce(new Error("Failed to fetch enums"));
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/failed to fetch enums/i)).toBeInTheDocument();
  });

  it("shows empty state when no enums exist", async () => {
    mockFetchEnums.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/no enum types/i)).toBeInTheDocument();
  });

  it("renders enum list with names and schemas", async () => {
    mockFetchEnums.mockResolvedValueOnce(mockEnums);
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("mood")).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
  });

  it("displays enum values as badges", async () => {
    mockFetchEnums.mockResolvedValueOnce(mockEnums);
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("happy")).toBeInTheDocument();
    });
    expect(screen.getByText("sad")).toBeInTheDocument();
    expect(screen.getByText("neutral")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("inactive")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("shows schema for each enum", async () => {
    mockFetchEnums.mockResolvedValueOnce([
      { name: "color", schema: "custom_schema", values: ["red", "blue"] },
    ]);
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("color")).toBeInTheDocument();
    });
    expect(screen.getByText("custom_schema")).toBeInTheDocument();
  });

  it("shows value count for each enum", async () => {
    mockFetchEnums.mockResolvedValueOnce(mockEnums);
    const { wrapper } = createQueryWrapper();
    render(<EnumsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("mood")).toBeInTheDocument();
    });
    // "3 values" should appear for both enums
    const valueCounts = screen.getAllByText("3 values");
    expect(valueCounts).toHaveLength(2);
  });
});
