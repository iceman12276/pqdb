import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchPerformanceFindings } = vi.hoisted(() => ({
  mockFetchPerformanceFindings: vi.fn(),
}));

vi.mock("~/lib/advisor", () => ({
  fetchPerformanceFindings: mockFetchPerformanceFindings,
}));

import { PerformancePage } from "~/components/performance-page";
import type { PerformanceFinding } from "~/lib/advisor";

const mockFindings: PerformanceFinding[] = [
  {
    rule_id: "missing_index",
    severity: "warning",
    category: "indexing",
    title: "Missing index on users",
    message: "Table users has 5000 rows and high sequential scans with no indexes.",
    table: "users",
    suggestion: "CREATE INDEX idx_users ON users (...)",
  },
  {
    rule_id: "stale_stats",
    severity: "info",
    category: "statistics",
    title: "Stale statistics on orders",
    message: "Table orders has never been analyzed.",
    table: "orders",
    suggestion: "ANALYZE orders;",
  },
  {
    rule_id: "dead_tuples",
    severity: "warning",
    category: "maintenance",
    title: "High dead tuple ratio on sessions",
    message: "Table sessions has a high ratio of dead tuples.",
    table: "sessions",
    suggestion: "VACUUM sessions;",
  },
];

describe("PerformancePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchPerformanceFindings.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("performance-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchPerformanceFindings.mockRejectedValueOnce(new Error("Failed to fetch performance findings"));
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/failed to fetch performance findings/i)).toBeInTheDocument();
  });

  it("shows empty state when no findings", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/no performance issues found/i)).toBeInTheDocument();
  });

  it("renders heading", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText("Performance")).toBeInTheDocument();
  });

  it("renders finding titles", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("Missing index on users")).toBeInTheDocument();
    expect(screen.getByText("Stale statistics on orders")).toBeInTheDocument();
    expect(screen.getByText("High dead tuple ratio on sessions")).toBeInTheDocument();
  });

  it("shows severity badges", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing index on users")).toBeInTheDocument();
    });
    // 2 warning badges + 1 warning group heading = 3 instances
    const warningBadges = screen.getAllByText("warning");
    expect(warningBadges.length).toBe(3);
    // 1 info badge + 1 info group heading = 2 instances
    const infoBadges = screen.getAllByText("info");
    expect(infoBadges.length).toBe(2);
  });

  it("shows messages for each finding", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing index on users")).toBeInTheDocument();
    });
    expect(screen.getByText(/5000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/never been analyzed/)).toBeInTheDocument();
  });

  it("shows affected table for each finding", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing index on users")).toBeInTheDocument();
    });
    // Tables shown in the cards
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText("sessions")).toBeInTheDocument();
  });

  it("shows suggested action for each finding", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing index on users")).toBeInTheDocument();
    });
    expect(screen.getByText("CREATE INDEX idx_users ON users (...)")).toBeInTheDocument();
    expect(screen.getByText("ANALYZE orders;")).toBeInTheDocument();
    expect(screen.getByText("VACUUM sessions;")).toBeInTheDocument();
  });

  it("groups findings by severity with warnings first", async () => {
    mockFetchPerformanceFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    const { container } = render(<PerformancePage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing index on users")).toBeInTheDocument();
    });

    // Find all severity group headings — warnings should appear before info
    const headings = container.querySelectorAll("[data-testid^='severity-group-']");
    expect(headings.length).toBe(2);
    expect(headings[0].getAttribute("data-testid")).toBe("severity-group-warning");
    expect(headings[1].getAttribute("data-testid")).toBe("severity-group-info");
  });
});
