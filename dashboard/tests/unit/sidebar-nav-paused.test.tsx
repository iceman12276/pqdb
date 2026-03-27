import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";
import { SidebarNav } from "~/components/sidebar-nav";

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

vi.mock("~/lib/projects", () => ({
  fetchProject: vi.fn(),
}));

function renderSidebar(props?: { projectStatus?: string }) {
  const { wrapper } = createQueryWrapper();
  return render(<SidebarNav {...props} />, { wrapper });
}

describe("SidebarNav - Paused State", () => {
  it("disables data-related nav items when project is paused", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    renderSidebar({ projectStatus: "paused" });

    const tableEditor = screen.getByText("Table Editor").closest("a");
    expect(tableEditor).toHaveAttribute("aria-disabled", "true");

    const queryPlayground = screen.getByText("Query Playground").closest("a");
    expect(queryPlayground).toHaveAttribute("aria-disabled", "true");

    const schema = screen.getByText("Schema").closest("a");
    expect(schema).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps Overview, Settings, API Keys, Logs enabled when paused", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    renderSidebar({ projectStatus: "paused" });

    const overview = screen.getByText("Project Overview").closest("a");
    expect(overview).not.toHaveAttribute("aria-disabled", "true");

    const settings = screen.getByText("Project Settings").closest("a");
    expect(settings).not.toHaveAttribute("aria-disabled", "true");

    const apiKeys = screen.getByText("API Keys").closest("a");
    expect(apiKeys).not.toHaveAttribute("aria-disabled", "true");

    const logs = screen.getByText("Logs").closest("a");
    expect(logs).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not disable any items when project is active", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    renderSidebar({ projectStatus: "active" });

    const tableEditor = screen.getByText("Table Editor").closest("a");
    expect(tableEditor).not.toHaveAttribute("aria-disabled", "true");

    const queryPlayground = screen.getByText("Query Playground").closest("a");
    expect(queryPlayground).not.toHaveAttribute("aria-disabled", "true");

    const schema = screen.getByText("Schema").closest("a");
    expect(schema).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not disable any items when no projectStatus provided", () => {
    mockUseParams.mockReturnValue({ projectId: "proj-123" });
    renderSidebar();

    const tableEditor = screen.getByText("Table Editor").closest("a");
    expect(tableEditor).not.toHaveAttribute("aria-disabled", "true");
  });
});
