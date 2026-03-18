import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarNav, sidebarNavItems } from "~/components/sidebar-nav";

describe("SidebarNav", () => {
  it("renders the sidebar navigation", () => {
    render(<SidebarNav />);
    expect(screen.getByTestId("sidebar-nav")).toBeInTheDocument();
  });

  it("renders the pqdb brand", () => {
    render(<SidebarNav />);
    expect(screen.getByText("pqdb")).toBeInTheDocument();
  });

  it("renders all required sidebar items", () => {
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
    render(<SidebarNav />);

    const realtimeItem = screen.getByText("Realtime").closest("a");
    const mcpItem = screen.getByText("MCP").closest("a");

    expect(realtimeItem).toHaveAttribute("aria-disabled", "true");
    expect(mcpItem).toHaveAttribute("aria-disabled", "true");
  });

  it("does not gray out non-disabled items", () => {
    render(<SidebarNav />);

    const overviewItem = screen.getByText("Project Overview").closest("a");
    expect(overviewItem).not.toHaveAttribute("aria-disabled", "true");
  });

  it("exports sidebarNavItems with correct count", () => {
    expect(sidebarNavItems).toHaveLength(9);
  });

  it("marks only Realtime and MCP as disabled in nav items", () => {
    const disabledItems = sidebarNavItems.filter((item) => item.disabled);
    expect(disabledItems).toHaveLength(2);
    expect(disabledItems.map((i) => i.label)).toEqual(["Realtime", "MCP"]);
  });
});
