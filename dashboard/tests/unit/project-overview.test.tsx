import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProjectOverview } = vi.hoisted(() => ({
  mockFetchProjectOverview: vi.fn(),
}));

vi.mock("~/lib/project-overview", () => ({
  fetchProjectOverview: mockFetchProjectOverview,
}));

import { ProjectOverviewPage } from "~/components/project-overview-page";

const mockOverview = {
  project_id: "p1",
  name: "My App",
  status: "active",
  region: "us-east-1",
  database_name: "pqdb_project_abc123",
  created_at: "2026-01-15T10:00:00Z",
  encryption: "ML-KEM-768",
  tables_count: 3,
  auth_users_count: 12,
  rls_policies_count: 2,
  database_requests: 150,
  auth_requests: 45,
  realtime_requests: 0,
  mcp_requests: 0,
};

describe("ProjectOverviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching", () => {
    mockFetchProjectOverview.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });
    expect(screen.getByTestId("project-overview")).toBeInTheDocument();
  });

  it("renders status cards with project data", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(mockOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("My App")).toBeInTheDocument();
    });

    expect(screen.getByTestId("status-cards")).toBeInTheDocument();
    expect(screen.getByTestId("status-card-status")).toBeInTheDocument();
    expect(screen.getByTestId("status-card-tables")).toBeInTheDocument();
    expect(screen.getByTestId("status-card-encryption")).toBeInTheDocument();
    expect(screen.getByTestId("status-card-auth-users")).toBeInTheDocument();
    expect(screen.getByTestId("status-card-rls-policies")).toBeInTheDocument();
  });

  it("renders request breakdown cards", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(mockOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("request-cards")).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("status-card-database-requests"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("status-card-auth-requests"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("status-card-realtime-requests"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("status-card-mcp-requests"),
    ).toBeInTheDocument();
  });

  it("renders connection info", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(mockOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("connection-info")).toBeInTheDocument();
    });

    expect(screen.getByTestId("database-name")).toHaveTextContent(
      "pqdb_project_abc123",
    );
  });

  it("shows encryption as ML-KEM-768", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(mockOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("ML-KEM-768")).toBeInTheDocument();
    });
  });

  it("shows error state on fetch failure", async () => {
    mockFetchProjectOverview.mockRejectedValueOnce(new Error("Failed"));
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("overview-error")).toBeInTheDocument();
    });
  });

  it("renders table count in status card", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(mockOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });
});
