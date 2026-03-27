import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProjectOverview, mockRestoreProject } = vi.hoisted(() => ({
  mockFetchProjectOverview: vi.fn(),
  mockRestoreProject: vi.fn(),
}));

vi.mock("~/lib/project-overview", () => ({
  fetchProjectOverview: mockFetchProjectOverview,
}));

vi.mock("~/lib/projects", () => ({
  restoreProject: mockRestoreProject,
}));

import { ProjectOverviewPage } from "~/components/project-overview-page";

const activeOverview = {
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

const pausedOverview = {
  ...activeOverview,
  status: "paused",
};

describe("ProjectOverviewPage - Pause Banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows paused banner when project is paused", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(pausedOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("paused-banner")).toBeInTheDocument();
    });

    expect(screen.getByTestId("paused-banner")).toHaveTextContent(
      "This project is paused. Data operations are blocked. Restore to resume.",
    );
  });

  it("does not show paused banner when project is active", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(activeOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("My App")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("paused-banner")).not.toBeInTheDocument();
  });

  it("has a Restore button in the paused banner", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(pausedOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("paused-banner")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /restore/i }),
    ).toBeInTheDocument();
  });

  it("calls restoreProject when Restore button is clicked", async () => {
    const user = userEvent.setup();
    mockFetchProjectOverview.mockResolvedValueOnce(pausedOverview);
    mockRestoreProject.mockResolvedValueOnce({ ...pausedOverview, status: "active" });
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("paused-banner")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /restore/i }));

    await waitFor(() => {
      expect(mockRestoreProject).toHaveBeenCalledWith("p1");
    });
  });

  it("shows destructive badge for paused status", async () => {
    mockFetchProjectOverview.mockResolvedValueOnce(pausedOverview);
    const { wrapper } = createQueryWrapper();
    render(<ProjectOverviewPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("project-status-badge")).toBeInTheDocument();
    });

    expect(screen.getByTestId("project-status-badge")).toHaveTextContent("paused");
  });
});
