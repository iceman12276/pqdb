import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarNav, sidebarNavItems } from "~/components/sidebar-nav";

// Mock @tanstack/react-router
const mockUseParams = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useParams: (...args: unknown[]) => mockUseParams(...args),
  Link: ({
    to,
    children,
    className,
    "aria-disabled": ariaDisabled,
    ...rest
  }: {
    to?: string;
    children: React.ReactNode;
    className?: string;
    "aria-disabled"?: boolean;
    [key: string]: unknown;
  }) => (
    <a href={to} className={className} aria-disabled={ariaDisabled} {...rest}>
      {children}
    </a>
  ),
}));

describe("SidebarNav", () => {
  it("renders the sidebar navigation", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    render(<SidebarNav />);
    expect(screen.getByTestId("sidebar-nav")).toBeInTheDocument();
  });

  it("renders the pqdb brand", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    render(<SidebarNav />);
    expect(screen.getByText("pqdb")).toBeInTheDocument();
  });

  it("renders all required sidebar items", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    render(<SidebarNav />);

    const requiredItems = [
      "Project Overview",
      "Table Editor",
      "Query Playground",
      "Schema",
      "Authentication",
      "Realtime",
      "Logs",
      "MCP",
      "Project Settings",
    ];

    for (const item of requiredItems) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });

  it("grays out Realtime and MCP items", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    render(<SidebarNav />);

    const realtimeItem = screen.getByText("Realtime").closest("a");
    const mcpItem = screen.getByText("MCP").closest("a");

    expect(realtimeItem).toHaveAttribute("aria-disabled", "true");
    expect(mcpItem).toHaveAttribute("aria-disabled", "true");
  });

  it("does not gray out non-disabled items", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    render(<SidebarNav />);

    const overviewItem = screen.getByText("Project Overview").closest("a");
    expect(overviewItem).not.toHaveAttribute("aria-disabled", "true");
  });

  it("generates project-scoped links when projectId is available", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-abc" });
    render(<SidebarNav />);

    const overviewLink = screen.getByText("Project Overview").closest("a");
    expect(overviewLink).toHaveAttribute("href", "/projects/proj-abc");

    const tablesLink = screen.getByText("Table Editor").closest("a");
    expect(tablesLink).toHaveAttribute("href", "/projects/proj-abc/tables");

    const queryLink = screen.getByText("Query Playground").closest("a");
    expect(queryLink).toHaveAttribute("href", "/projects/proj-abc/sql");

    const schemaLink = screen.getByText("Schema").closest("a");
    expect(schemaLink).toHaveAttribute("href", "/projects/proj-abc/schema");

    const authLink = screen.getByText("Authentication").closest("a");
    expect(authLink).toHaveAttribute("href", "/projects/proj-abc/auth");

    const logsLink = screen.getByText("Logs").closest("a");
    expect(logsLink).toHaveAttribute("href", "/projects/proj-abc/logs");

    const settingsLink = screen.getByText("Project Settings").closest("a");
    expect(settingsLink).toHaveAttribute(
      "href",
      "/projects/proj-abc/settings",
    );
  });

  it("links to /projects when no projectId is available", () => {
    mockUseParams.mockReturnValue({});
    render(<SidebarNav />);

    const overviewLink = screen.getByText("Project Overview").closest("a");
    expect(overviewLink).toHaveAttribute("href", "/projects");

    const tablesLink = screen.getByText("Table Editor").closest("a");
    expect(tablesLink).toHaveAttribute("href", "/projects");
  });

  it("calls useParams with strict: false", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    render(<SidebarNav />);
    expect(mockUseParams).toHaveBeenCalledWith({ strict: false });
  });
});
