/**
 * Branch types and API functions for the Dashboard.
 * Calls GET/POST/DELETE /v1/projects/{id}/branches via the authenticated API client.
 */

import { api } from "./api-client";

export interface Branch {
  id: string;
  name: string;
  database_name: string;
  status: string;
  created_at: string;
}

export interface PromoteResult {
  status: string;
  old_database: string;
  new_database: string;
  stale_branches: string[];
}

export interface RebaseResult {
  status: string;
  name: string;
  database_name: string;
}

export async function listBranches(projectId: string): Promise<Branch[]> {
  const result = await api.fetch(`/v1/projects/${projectId}/branches`);
  if (!result.ok) {
    throw new Error("Failed to fetch branches");
  }
  return result.data as Branch[];
}

export async function createBranch(
  projectId: string,
  name: string,
): Promise<Branch> {
  const result = await api.fetch(`/v1/projects/${projectId}/branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!result.ok) {
    const errorData = result.data as {
      detail?: string | { error?: { message?: string } };
    } | null;
    const detail = errorData?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail?.error?.message ?? "Failed to create branch";
    throw new Error(message);
  }
  return result.data as Branch;
}

export async function deleteBranch(
  projectId: string,
  branchName: string,
): Promise<void> {
  const result = await api.fetch(
    `/v1/projects/${projectId}/branches/${branchName}`,
    { method: "DELETE" },
  );
  if (!result.ok) {
    throw new Error("Failed to delete branch");
  }
}

export async function promoteBranch(
  projectId: string,
  branchName: string,
  force = false,
): Promise<PromoteResult> {
  const result = await api.fetch(
    `/v1/projects/${projectId}/branches/${branchName}/promote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    },
  );
  if (!result.ok) {
    const errorData = result.data as { detail?: string } | null;
    throw new Error(errorData?.detail ?? "Failed to promote branch");
  }
  return result.data as PromoteResult;
}

export async function rebaseBranch(
  projectId: string,
  branchName: string,
): Promise<RebaseResult> {
  const result = await api.fetch(
    `/v1/projects/${projectId}/branches/${branchName}/rebase`,
    { method: "POST" },
  );
  if (!result.ok) {
    throw new Error("Failed to rebase branch");
  }
  return result.data as RebaseResult;
}

export async function resetBranch(
  projectId: string,
  branchName: string,
): Promise<RebaseResult> {
  const result = await api.fetch(
    `/v1/projects/${projectId}/branches/${branchName}/reset`,
    { method: "POST" },
  );
  if (!result.ok) {
    throw new Error("Failed to reset branch");
  }
  return result.data as RebaseResult;
}
