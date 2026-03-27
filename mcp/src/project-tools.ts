/**
 * Project management tools for the pqdb MCP server.
 *
 * Tools:
 *   - pqdb_get_project: get project details by ID (uses apikey)
 *   - pqdb_list_projects: list all projects for the developer (uses dev JWT)
 *   - pqdb_create_project: create a new project (uses dev JWT)
 *   - pqdb_get_logs: get audit log entries for a project (uses apikey)
 *   - pqdb_pause_project: pause a project (uses dev JWT)
 *   - pqdb_restore_project: restore a paused project (uses dev JWT)
 *   - pqdb_create_branch: create a database branch (uses dev JWT)
 *   - pqdb_list_branches: list branches for a project (uses dev JWT)
 *   - pqdb_delete_branch: delete a database branch (uses dev JWT)
 *   - pqdb_merge_branch: promote/merge a branch into main (uses dev JWT)
 *   - pqdb_rebase_branch: rebase a branch from main (uses dev JWT)
 *   - pqdb_reset_branch: reset a branch to match main (uses dev JWT)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Standard { data, error } response shape. */
interface ApiResponse {
  data: unknown | null;
  error: string | null;
}

/** Make an authenticated GET request using developer JWT. */
async function devGet<T>(
  projectUrl: string,
  devToken: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${devToken}` },
  });

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

/** Make an authenticated POST request using developer JWT. */
async function devPost<T>(
  projectUrl: string,
  devToken: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${devToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = (await response.json()) as { detail?: string };
      detail = errorBody.detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

/** Make an authenticated DELETE request using developer JWT. */
async function devDelete(
  projectUrl: string,
  devToken: string,
  path: string,
): Promise<void> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${devToken}` },
  });

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }
}

/** Build a success MCP tool result. */
function successResult(response: ApiResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/** Build an error MCP tool result. */
function errorResult(response: ApiResponse) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/** Check that dev token is available, return error result if not. */
function requireDevToken(devToken: string | undefined): ReturnType<typeof errorResult> | null {
  if (!devToken) {
    return errorResult({
      data: null,
      error:
        "Developer authentication required. Set the PQDB_DEV_TOKEN environment variable " +
        "with a valid developer JWT to use this tool.",
    });
  }
  return null;
}

/**
 * Register project management tools on the MCP server.
 */
export function registerProjectTools(
  mcpServer: McpServer,
  projectUrl: string,
  _apiKey: string,
  devToken: string | undefined,
): void {
  // ── pqdb_get_project ────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_get_project",
    "Get project details — name, status, region, database name, created date",
    {
      project_id: z.string().describe("ID of the project to retrieve"),
    },
    async ({ project_id }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const project = await devGet<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}`,
        );

        return successResult({ data: project, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to get project",
        });
      }
    },
  );

  // ── pqdb_list_projects ──────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_projects",
    "List all projects for the authenticated developer. Requires PQDB_DEV_TOKEN.",
    {},
    async () => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const projects = await devGet<unknown[]>(
          projectUrl,
          devToken!,
          "/v1/projects",
        );

        return successResult({ data: projects, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list projects",
        });
      }
    },
  );

  // ── pqdb_create_project ─────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_create_project",
    "Create a new pqdb project. Requires PQDB_DEV_TOKEN.",
    {
      name: z.string().describe("Name of the project"),
      region: z.string().optional().describe("Region for the project (e.g. us-east-1)"),
    },
    async ({ name, region }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const body: Record<string, string> = { name };
        if (region) body.region = region;

        const project = await devPost<unknown>(
          projectUrl,
          devToken!,
          "/v1/projects",
          body,
        );

        return successResult({ data: project, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to create project",
        });
      }
    },
  );

  // ── pqdb_get_logs ───────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_get_logs",
    "Get audit log entries for a project",
    {
      project_id: z.string().describe("ID of the project to get logs for"),
    },
    async ({ project_id }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const logs = await devGet<unknown[]>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/logs`,
        );

        return successResult({ data: logs, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to get logs",
        });
      }
    },
  );

  // ── pqdb_pause_project ──────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_pause_project",
    "Pause a project. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project to pause"),
    },
    async ({ project_id }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/pause`,
          {},
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to pause project",
        });
      }
    },
  );

  // ── pqdb_restore_project ────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_restore_project",
    "Restore a paused project. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project to restore"),
    },
    async ({ project_id }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/restore`,
          {},
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to restore project",
        });
      }
    },
  );

  // ── pqdb_create_branch ───────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_create_branch",
    "Create a new database branch for a project. Branches provide isolated copies of the schema and data for development/testing. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project to create a branch in"),
      name: z.string().describe("Name of the branch to create"),
    },
    async ({ project_id, name }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches`,
          { name },
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to create branch",
        });
      }
    },
  );

  // ── pqdb_list_branches ───────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_list_branches",
    "List all branches for a project. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project to list branches for"),
    },
    async ({ project_id }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const branches = await devGet<unknown[]>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches`,
        );

        return successResult({ data: branches, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to list branches",
        });
      }
    },
  );

  // ── pqdb_delete_branch ───────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_delete_branch",
    "Delete a database branch. The main branch cannot be deleted. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project"),
      name: z.string().describe("Name of the branch to delete"),
    },
    async ({ project_id, name }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        await devDelete(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches/${encodeURIComponent(name)}`,
        );

        return successResult({ data: { deleted: true }, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to delete branch",
        });
      }
    },
  );

  // ── pqdb_merge_branch ────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_merge_branch",
    "Promote (merge) a branch into main. Applies all branch changes to the main database. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project"),
      name: z.string().describe("Name of the branch to merge into main"),
    },
    async ({ project_id, name }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches/${encodeURIComponent(name)}/promote`,
          {},
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to merge branch",
        });
      }
    },
  );

  // ── pqdb_rebase_branch ───────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_rebase_branch",
    "Rebase a branch from main. Pulls the latest main schema and data into the branch. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project"),
      name: z.string().describe("Name of the branch to rebase"),
    },
    async ({ project_id, name }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches/${encodeURIComponent(name)}/rebase`,
          {},
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to rebase branch",
        });
      }
    },
  );

  // ── pqdb_reset_branch ────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_reset_branch",
    "Reset a branch to match main. Discards all branch changes and resets to the current main state. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project"),
      name: z.string().describe("Name of the branch to reset"),
    },
    async ({ project_id, name }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches/${encodeURIComponent(name)}/reset`,
          {},
        );

        return successResult({ data: result, error: null });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to reset branch",
        });
      }
    },
  );
}
