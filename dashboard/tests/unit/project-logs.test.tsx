import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProjectLogs } = vi.hoisted(() => ({
  mockFetchProjectLogs: vi.fn(),
}));

vi.mock("~/lib/project-overview", () => ({
  fetchProjectLogs: mockFetchProjectLogs,
}));

import { ProjectLogsPage } from "~/components/project-logs-page";

const mockLogs = {
  data: [
    {
      id: "log1",
      event_type: "database",
      method: "POST",
      path: "/v1/db/users/select",
      status_code: 200,
      project_id: "p1",
      user_id: null,
      ip_address: "127.0.0.1",
      created_at: "2026-03-15T10:00:00Z",
    },
    {
      id: "log2",
      event_type: "auth",
      method: "POST",
      path: "/v1/auth/login",
      status_code: 401,
      project_id: "p1",
      user_id: null,
      ip_address: "192.168.1.1",
      created_at: "2026-03-15T09:30:00Z",
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

describe("ProjectLogsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching", () => {
    mockFetchProjectLogs.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });
    expect(screen.getByTestId("logs-loading")).toBeInTheDocument();
  });

  it("renders log entries in a table", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("log-table")).toBeInTheDocument();
    });

    const rows = screen.getAllByTestId("log-row");
    expect(rows).toHaveLength(2);
  });

  it("shows total count", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("log-total")).toHaveTextContent("2 total entries");
    });
  });

  it("displays event type badges", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      const badges = screen.getAllByTestId("log-event-type");
      expect(badges[0]).toHaveTextContent("database");
      expect(badges[1]).toHaveTextContent("auth");
    });
  });

  it("displays status code badges", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      const badges = screen.getAllByTestId("log-status-code");
      expect(badges[0]).toHaveTextContent("200");
      expect(badges[1]).toHaveTextContent("401");
    });
  });

  it("shows empty state when no logs", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce({
      data: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("logs-empty")).toBeInTheDocument();
    });
  });

  it("renders filter controls", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("log-filters")).toBeInTheDocument();
    });
    expect(screen.getByTestId("filter-event-type")).toBeInTheDocument();
    expect(screen.getByTestId("filter-status-code")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchProjectLogs.mockRejectedValueOnce(new Error("Failed"));
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("logs-error")).toBeInTheDocument();
    });
  });

  it("shows pagination when more than one page", async () => {
    const manyLogs = {
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `log${i}`,
        event_type: "database",
        method: "GET",
        path: "/v1/db/tables",
        status_code: 200,
        project_id: "p1",
        user_id: null,
        ip_address: "127.0.0.1",
        created_at: "2026-03-15T10:00:00Z",
      })),
      total: 45,
      limit: 20,
      offset: 0,
    };
    mockFetchProjectLogs.mockResolvedValueOnce(manyLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("log-pagination")).toBeInTheDocument();
    });
    expect(screen.getByTestId("prev-page")).toBeDisabled();
    expect(screen.getByTestId("next-page")).not.toBeDisabled();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("does not show pagination for single page", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("log-table")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("log-pagination")).not.toBeInTheDocument();
  });

  it("renders Audit Logs title", async () => {
    mockFetchProjectLogs.mockResolvedValueOnce(mockLogs);
    const { wrapper } = createQueryWrapper();
    render(<ProjectLogsPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Audit Logs")).toBeInTheDocument();
    });
  });
});
