/**
 * Project types and API functions for the Dashboard.
 * Calls GET/POST /v1/projects via the authenticated API client.
 */

import { api } from "./api-client";

export interface Project {
  id: string;
  name: string;
  region: string;
  status: string;
  database_name: string | null;
  created_at: string;
}

export interface ApiKeyCreated {
  id: string;
  role: string;
  key: string;
  key_prefix: string;
}

export interface ApiKeyInfo {
  id: string;
  role: string;
  key_prefix: string;
  created_at: string;
}

export interface ProjectCreateResponse extends Project {
  api_keys: ApiKeyCreated[];
}

export async function fetchProjects(): Promise<Project[]> {
  const result = await api.fetch("/v1/projects");
  if (!result.ok) {
    throw new Error("Failed to fetch projects");
  }
  return result.data as Project[];
}

export async function fetchProject(projectId: string): Promise<Project> {
  const result = await api.fetch(`/v1/projects/${projectId}`);
  if (!result.ok) {
    throw new Error("Failed to fetch project");
  }
  return result.data as Project;
}

export async function createProject(
  name: string,
  region?: string,
): Promise<ProjectCreateResponse> {
  const body: Record<string, string> = { name };
  if (region) body.region = region;

  const result = await api.fetch("/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    const errorData = result.data as { error?: { message?: string }; detail?: string } | null;
    throw new Error(
      errorData?.error?.message ?? errorData?.detail ?? "Failed to create project",
    );
  }
  return result.data as ProjectCreateResponse;
}

export async function fetchProjectKeys(projectId: string): Promise<ApiKeyInfo[]> {
  const result = await api.fetch(`/v1/projects/${projectId}/keys`);
  if (!result.ok) {
    throw new Error("Failed to fetch API keys");
  }
  return result.data as ApiKeyInfo[];
}

export async function rotateProjectKeys(projectId: string): Promise<ApiKeyCreated[]> {
  const result = await api.fetch(`/v1/projects/${projectId}/keys/rotate`, {
    method: "POST",
  });
  if (!result.ok) {
    throw new Error("Failed to rotate API keys");
  }
  return result.data as ApiKeyCreated[];
}
