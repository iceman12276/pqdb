import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

// Mock branches lib
const mockListBranches = vi.fn();
const mockCreateBranch = vi.fn();
vi.mock("~/lib/branches", () => ({
  listBranches: (...args: unknown[]) => mockListBranches(...args),
  createBranch: (...args: unknown[]) => mockCreateBranch(...args),
}));

import { BranchSelector } from "~/components/branch-selector";

function renderSelector(props?: {
  projectId?: string;
  activeBranch?: string | null;
  onBranchChange?: (branch: string | null) => void;
}) {
  const { wrapper } = createQueryWrapper();
  const defaultProps = {
    projectId: "proj-123",
    activeBranch: null as string | null,
    onBranchChange: vi.fn(),
    ...props,
  };
  return {
    ...render(<BranchSelector {...defaultProps} />, { wrapper }),
    onBranchChange: defaultProps.onBranchChange,
  };
}

describe("BranchSelector", () => {
  beforeEach(() => {
    mockListBranches.mockReset();
    mockCreateBranch.mockReset();
  });

  it("renders the branch selector with main as default", async () => {
    mockListBranches.mockResolvedValue([]);
    renderSelector();

    expect(screen.getByTestId("branch-selector")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });

  it("shows branches in dropdown when clicked", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-01" },
      { id: "b2", name: "fix-bug", status: "rebasing", database_name: "db2", created_at: "2026-01-02" },
    ]);
    renderSelector();

    const trigger = screen.getByTestId("branch-selector-trigger");
    await userEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("feat-auth")).toBeInTheDocument();
      expect(screen.getByText("fix-bug")).toBeInTheDocument();
    });
  });

  it("shows status badges for non-active branches", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "rebasing", database_name: "db1", created_at: "2026-01-01" },
    ]);
    renderSelector();

    const trigger = screen.getByTestId("branch-selector-trigger");
    await userEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("rebasing")).toBeInTheDocument();
    });
  });

  it("calls onBranchChange when a branch is selected", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-01" },
    ]);
    const { onBranchChange } = renderSelector();

    const trigger = screen.getByTestId("branch-selector-trigger");
    await userEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("feat-auth")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("feat-auth"));
    expect(onBranchChange).toHaveBeenCalledWith("feat-auth");
  });

  it("calls onBranchChange with null when main is selected", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-01" },
    ]);
    const { onBranchChange } = renderSelector({ activeBranch: "feat-auth" });

    const trigger = screen.getByTestId("branch-selector-trigger");
    await userEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByTestId("branch-option-main")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("branch-option-main"));
    expect(onBranchChange).toHaveBeenCalledWith(null);
  });

  it("shows create branch button in dropdown", async () => {
    mockListBranches.mockResolvedValue([]);
    renderSelector();

    const trigger = screen.getByTestId("branch-selector-trigger");
    await userEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByTestId("create-branch-btn")).toBeInTheDocument();
    });
  });

  it("displays active branch name when one is selected", () => {
    mockListBranches.mockResolvedValue([]);
    renderSelector({ activeBranch: "feat-auth" });

    expect(screen.getByText("feat-auth")).toBeInTheDocument();
  });
});
