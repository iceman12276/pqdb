import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchSecurityFindings } = vi.hoisted(() => ({
  mockFetchSecurityFindings: vi.fn(),
}));

vi.mock("~/lib/advisor", () => ({
  fetchSecurityFindings: mockFetchSecurityFindings,
}));

import { SecurityPage } from "~/components/security-page";
import type { SecurityFinding } from "~/lib/advisor";

const mockFindings: SecurityFinding[] = [
  {
    rule_id: "missing_rls",
    severity: "critical",
    category: "access_control",
    title: "Missing RLS on users",
    message: "Table users has no row-level security policies enabled.",
    table: "users",
    suggestion: "ALTER TABLE users ENABLE ROW LEVEL SECURITY;",
  },
  {
    rule_id: "plain_pii",
    severity: "warning",
    category: "encryption",
    title: "Unencrypted PII column: email",
    message: "Column email on table users is stored in plain text.",
    table: "users",
    suggestion: "Change column sensitivity to 'searchable' or 'private'.",
  },
  {
    rule_id: "delete_permission",
    severity: "info",
    category: "permissions",
    title: "Scoped key has DELETE permission",
    message: "API key 'admin-key' has DELETE permission on all tables.",
    table: null,
    suggestion: null,
  },
  {
    rule_id: "missing_owner",
    severity: "warning",
    category: "access_control",
    title: "No owner column on orders",
    message: "Table orders has no user_id or owner column for RLS filtering.",
    table: "orders",
    suggestion: "Add a user_id column for row-level ownership.",
  },
];

describe("SecurityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchSecurityFindings.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("security-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchSecurityFindings.mockRejectedValueOnce(new Error("Failed to fetch security findings"));
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/failed to fetch security findings/i)).toBeInTheDocument();
  });

  it("shows empty state when no findings", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/no security issues found\. your project looks good!/i)).toBeInTheDocument();
  });

  it("renders heading", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText("Security")).toBeInTheDocument();
  });

  it("renders summary bar with counts", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    await waitFor(() => {
      expect(screen.getByTestId("summary-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("summary-critical")).toHaveTextContent("1");
    expect(screen.getByTestId("summary-warning")).toHaveTextContent("2");
    expect(screen.getByTestId("summary-info")).toHaveTextContent("1");
  });

  it("renders finding titles", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("Missing RLS on users")).toBeInTheDocument();
    expect(screen.getByText("Unencrypted PII column: email")).toBeInTheDocument();
    expect(screen.getByText("Scoped key has DELETE permission")).toBeInTheDocument();
    expect(screen.getByText("No owner column on orders")).toBeInTheDocument();
  });

  it("shows severity badges", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing RLS on users")).toBeInTheDocument();
    });
    // 1 critical card badge + 1 group heading + 1 summary bar = 3
    const criticalBadges = screen.getAllByText("critical");
    expect(criticalBadges.length).toBe(3);
    // 2 warning card badges + 1 group heading + 1 summary bar = 4
    const warningBadges = screen.getAllByText("warning");
    expect(warningBadges.length).toBe(4);
    // 1 info card badge + 1 group heading + 1 summary bar = 3
    const infoBadges = screen.getAllByText("info");
    expect(infoBadges.length).toBe(3);
  });

  it("shows messages for each finding", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing RLS on users")).toBeInTheDocument();
    });
    expect(screen.getByText(/no row-level security policies/)).toBeInTheDocument();
    expect(screen.getByText(/stored in plain text/)).toBeInTheDocument();
  });

  it("shows affected table for findings that have one", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing RLS on users")).toBeInTheDocument();
    });
    // "users" appears in multiple findings, "orders" in one
    expect(screen.getAllByText("users").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("shows suggested fix when present", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing RLS on users")).toBeInTheDocument();
    });
    expect(screen.getByText("ALTER TABLE users ENABLE ROW LEVEL SECURITY;")).toBeInTheDocument();
    expect(screen.getByText("Add a user_id column for row-level ownership.")).toBeInTheDocument();
  });

  it("groups findings by severity with critical first, then warning, then info", async () => {
    mockFetchSecurityFindings.mockResolvedValueOnce(mockFindings);
    const { wrapper } = createQueryWrapper();
    const { container } = render(<SecurityPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Missing RLS on users")).toBeInTheDocument();
    });

    const headings = container.querySelectorAll("[data-testid^='severity-group-']");
    expect(headings.length).toBe(3);
    expect(headings[0].getAttribute("data-testid")).toBe("severity-group-critical");
    expect(headings[1].getAttribute("data-testid")).toBe("severity-group-warning");
    expect(headings[2].getAttribute("data-testid")).toBe("severity-group-info");
  });
});
