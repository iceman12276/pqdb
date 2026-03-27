import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

// Mock branches lib
const mockListBranches = vi.fn();
const mockDeleteBranch = vi.fn();
const mockPromoteBranch = vi.fn();
const mockRebaseBranch = vi.fn();
vi.mock("~/lib/branches", () => ({
  listBranches: (...args: unknown[]) => mockListBranches(...args),
  deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
  promoteBranch: (...args: unknown[]) => mockPromoteBranch(...args),
  rebaseBranch: (...args: unknown[]) => mockRebaseBranch(...args),
  createBranch: vi.fn(),
}));

import { BranchesPage } from "~/components/branches-page";

function renderPage(projectId = "proj-123") {
  const { wrapper } = createQueryWrapper();
  return render(<BranchesPage projectId={projectId} />, { wrapper });
}

describe("BranchesPage", () => {
  beforeEach(() => {
    mockListBranches.mockReset();
    mockDeleteBranch.mockReset();
    mockPromoteBranch.mockReset();
    mockRebaseBranch.mockReset();
  });

  it("renders the page heading", async () => {
    mockListBranches.mockResolvedValue([]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Branches")).toBeInTheDocument();
    });
  });

  it("shows loading skeleton while fetching", () => {
    mockListBranches.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByTestId("branches-loading")).toBeInTheDocument();
  });

  it("shows empty state when no branches exist", async () => {
    mockListBranches.mockResolvedValue([]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/no branches/i)).toBeInTheDocument();
    });
  });

  it("lists branches with name, status, and created date", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-15T10:00:00Z" },
      { id: "b2", name: "fix-bug", status: "rebasing", database_name: "db2", created_at: "2026-01-16T10:00:00Z" },
    ]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("feat-auth")).toBeInTheDocument();
      expect(screen.getByText("fix-bug")).toBeInTheDocument();
      expect(screen.getByText("active")).toBeInTheDocument();
      expect(screen.getByText("rebasing")).toBeInTheDocument();
    });
  });

  it("shows delete confirmation dialog", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-15T10:00:00Z" },
    ]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("feat-auth")).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTestId("delete-branch-feat-auth");
    await userEvent.click(deleteBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/permanently delete the branch database/i),
      ).toBeInTheDocument();
    });
  });

  it("shows promote confirmation dialog", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-15T10:00:00Z" },
    ]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("feat-auth")).toBeInTheDocument();
    });

    const promoteBtn = screen.getByTestId("promote-branch-feat-auth");
    await userEvent.click(promoteBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/replace the main database with this branch/i),
      ).toBeInTheDocument();
    });
  });

  it("has rebase button for each branch", async () => {
    mockListBranches.mockResolvedValue([
      { id: "b1", name: "feat-auth", status: "active", database_name: "db1", created_at: "2026-01-15T10:00:00Z" },
    ]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("rebase-branch-feat-auth")).toBeInTheDocument();
    });
  });
});
