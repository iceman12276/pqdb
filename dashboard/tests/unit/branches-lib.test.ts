import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.mock("~/lib/api-client", () => ({
  api: {
    fetch: (...args: unknown[]) => mockFetch(...args),
  },
}));

import {
  listBranches,
  createBranch,
  deleteBranch,
  promoteBranch,
  rebaseBranch,
  resetBranch,
} from "~/lib/branches";

describe("branches lib", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("listBranches", () => {
    it("calls GET /v1/projects/{id}/branches", async () => {
      const branches = [
        { id: "b1", name: "feat-1", database_name: "db_b1", status: "active", created_at: "2026-01-01" },
      ];
      mockFetch.mockResolvedValue({ ok: true, status: 200, data: branches });

      const result = await listBranches("proj-123");
      expect(mockFetch).toHaveBeenCalledWith("/v1/projects/proj-123/branches");
      expect(result).toEqual(branches);
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, data: null });
      await expect(listBranches("proj-123")).rejects.toThrow("Failed to fetch branches");
    });
  });

  describe("createBranch", () => {
    it("calls POST /v1/projects/{id}/branches with name", async () => {
      const branch = { id: "b2", name: "my-branch", database_name: "db_b2", status: "active", created_at: "2026-01-01" };
      mockFetch.mockResolvedValue({ ok: true, status: 201, data: branch });

      const result = await createBranch("proj-123", "my-branch");
      expect(mockFetch).toHaveBeenCalledWith("/v1/projects/proj-123/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "my-branch" }),
      });
      expect(result).toEqual(branch);
    });

    it("throws with error message from detail string", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        data: { detail: "Branch 'my-branch' already exists." },
      });
      await expect(createBranch("proj-123", "my-branch")).rejects.toThrow(
        "Branch 'my-branch' already exists.",
      );
    });

    it("throws with error message from nested error object", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        data: { detail: { error: { message: "Invalid branch name" } } },
      });
      await expect(createBranch("proj-123", "BAD")).rejects.toThrow("Invalid branch name");
    });
  });

  describe("deleteBranch", () => {
    it("calls DELETE /v1/projects/{id}/branches/{name}", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, data: { status: "deleted" } });

      await deleteBranch("proj-123", "feat-1");
      expect(mockFetch).toHaveBeenCalledWith("/v1/projects/proj-123/branches/feat-1", {
        method: "DELETE",
      });
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, data: null });
      await expect(deleteBranch("proj-123", "nope")).rejects.toThrow("Failed to delete branch");
    });
  });

  describe("promoteBranch", () => {
    it("calls POST /v1/projects/{id}/branches/{name}/promote", async () => {
      const promoteResult = {
        status: "promoted",
        old_database: "old_db",
        new_database: "new_db",
        stale_branches: ["other"],
      };
      mockFetch.mockResolvedValue({ ok: true, status: 200, data: promoteResult });

      const result = await promoteBranch("proj-123", "feat-1", true);
      expect(mockFetch).toHaveBeenCalledWith(
        "/v1/projects/proj-123/branches/feat-1/promote",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        },
      );
      expect(result).toEqual(promoteResult);
    });

    it("defaults force to false", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        data: { status: "promoted", old_database: "a", new_database: "b", stale_branches: [] },
      });

      await promoteBranch("proj-123", "feat-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "/v1/projects/proj-123/branches/feat-1/promote",
        expect.objectContaining({
          body: JSON.stringify({ force: false }),
        }),
      );
    });

    it("throws on failure with detail", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        data: { detail: "Cannot promote: 2 active connection(s)." },
      });
      await expect(promoteBranch("proj-123", "feat-1")).rejects.toThrow(
        "Cannot promote: 2 active connection(s).",
      );
    });
  });

  describe("rebaseBranch", () => {
    it("calls POST /v1/projects/{id}/branches/{name}/rebase", async () => {
      const rebaseResult = { status: "rebased", name: "feat-1", database_name: "db_b1" };
      mockFetch.mockResolvedValue({ ok: true, status: 200, data: rebaseResult });

      const result = await rebaseBranch("proj-123", "feat-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "/v1/projects/proj-123/branches/feat-1/rebase",
        { method: "POST" },
      );
      expect(result).toEqual(rebaseResult);
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, data: null });
      await expect(rebaseBranch("proj-123", "feat-1")).rejects.toThrow("Failed to rebase branch");
    });
  });

  describe("resetBranch", () => {
    it("calls POST /v1/projects/{id}/branches/{name}/reset", async () => {
      const resetResult = { status: "rebased", name: "feat-1", database_name: "db_b1" };
      mockFetch.mockResolvedValue({ ok: true, status: 200, data: resetResult });

      const result = await resetBranch("proj-123", "feat-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "/v1/projects/proj-123/branches/feat-1/reset",
        { method: "POST" },
      );
      expect(result).toEqual(resetResult);
    });
  });
});
