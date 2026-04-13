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
import { encapsulate, decapsulate } from "@pqdb/client";
import {
  clearCurrentSharedSecret,
  getCurrentPrivateKey,
  setCurrentProjectId,
  setCurrentSharedSecret,
} from "./auth-state.js";

/** Standard { data, error } response shape. */
interface ApiResponse {
  data: unknown | null;
  error: string | null;
}

/**
 * Extract a human-readable error detail from a non-OK Response.
 *
 * FastAPI returns errors in several shapes:
 *   - { detail: "plain string" }
 *   - { detail: { error: { code, message } } }  (structured error)
 *   - { detail: <arbitrary object> }
 *   - non-JSON body
 *
 * Previously these helpers typed detail as `string`, so structured errors
 * were coerced to the literal "[object Object]" when thrown. This helper
 * handles all shapes and always returns a meaningful string.
 */
async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    const d = body.detail;
    if (typeof d === "string") {
      return d;
    }
    if (d && typeof d === "object" && "error" in d) {
      const err = (d as { error: { code?: string; message?: string } }).error;
      return err.message ?? err.code ?? response.statusText;
    }
    if (d !== undefined && d !== null) {
      return JSON.stringify(d);
    }
  } catch {
    // Non-JSON body — fall through to statusText
  }
  return response.statusText;
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
    throw new Error(await extractErrorDetail(response));
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
    throw new Error(await extractErrorDetail(response));
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
    throw new Error(await extractErrorDetail(response));
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

/** Encode Uint8Array to standard base64. */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode standard base64 to Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
  // ── pqdb_select_project ─────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_select_project",
    "Switch the active project. All subsequent project-scoped operations (tables, rows, SQL) will target this project. Use pqdb_list_projects to see available projects.",
    {
      project_id: z.string().describe("ID of the project to select"),
    },
    async ({ project_id }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const project = await devGet<{
          id: string;
          name: string;
          status: string;
          wrapped_encryption_key?: string | null;
        }>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}`,
        );

        setCurrentProjectId(project.id);

        // Reset any prior shared secret before deriving a new one.
        clearCurrentSharedSecret();

        // Unwrap the per-project encryption key if both a configured
        // private key AND a server-stored wrapped key are present.
        const privKey = getCurrentPrivateKey();
        let encryptionActive = false;
        if (privKey && project.wrapped_encryption_key) {
          try {
            const wrapped = base64ToBytes(project.wrapped_encryption_key);
            const sharedSecret = await decapsulate(wrapped, privKey);
            setCurrentSharedSecret(sharedSecret);
            encryptionActive = true;
          } catch (decapErr) {
            return errorResult({
              data: null,
              error:
                "Failed to decapsulate wrapped_encryption_key with the configured PQDB_PRIVATE_KEY: " +
                (decapErr instanceof Error
                  ? decapErr.message
                  : String(decapErr)),
            });
          }
        }

        // Project object is returned as-is (wrapped_encryption_key is
        // already ciphertext, and the decapsulated shared secret is
        // intentionally NOT included in the response).
        return successResult({
          data: {
            message: `Switched to project "${project.name}" (${project.id})`,
            project,
            active_project_id: project.id,
            encryption_active: encryptionActive,
          },
          error: null,
        });
      } catch (err) {
        return errorResult({
          data: null,
          error: err instanceof Error ? err.message : "Failed to select project",
        });
      }
    },
  );

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
    "Create a new pqdb project. Requires PQDB_DEV_TOKEN. When PQDB_PRIVATE_KEY is also set, the project is created with a ML-KEM-768 wrapped encryption key so searchable/private columns can be used immediately. When called from the crypto proxy, `wrapped_encryption_key` may be supplied in the args and will be forwarded to the backend as-is.",
    {
      name: z.string().describe("Name of the project"),
      region: z.string().optional().describe("Region for the project (e.g. us-east-1)"),
      wrapped_encryption_key: z
        .string()
        .optional()
        .describe(
          "Base64-encoded ML-KEM-768 ciphertext. Proxy clients supply this; " +
            "native callers leave it unset and rely on PQDB_PRIVATE_KEY.",
        ),
    },
    async ({ name, region, wrapped_encryption_key }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const body: Record<string, string> = { name };
        if (region) body.region = region;

        const privKey = getCurrentPrivateKey();
        let warning: string | null = null;
        let wrappedEncryptionKeyPresent = false;
        // Always reset any prior shared secret before creating a new project.
        clearCurrentSharedSecret();

        // Hold the freshly-encapsulated shared secret locally until the
        // create POST succeeds. If devPost throws, we must NOT leave a
        // stale shared secret pointing at a project that doesn't exist.
        let pendingSharedSecret: Uint8Array | null = null;

        if (privKey) {
          // Native path: this MCP holds a private key, so it owns the crypto.
          // Fetch the developer's stored ML-KEM public key.
          const pkResp = await devGet<{ public_key: string | null }>(
            projectUrl,
            devToken!,
            "/v1/auth/me/public-key",
          );
          if (!pkResp.public_key) {
            return errorResult({
              data: null,
              error:
                "Developer has no ML-KEM public key on file. Upload one before " +
                "creating an encrypted project (see the dashboard signup/key-management flow).",
            });
          }

          const publicKey = base64ToBytes(pkResp.public_key);
          const { ciphertext, sharedSecret } = await encapsulate(publicKey);

          // Send the wrapped encryption key in the create body.
          body.wrapped_encryption_key = bytesToBase64(ciphertext);

          // Defer committing the shared secret until AFTER the POST succeeds.
          pendingSharedSecret = sharedSecret;
        } else if (wrapped_encryption_key) {
          // Proxy path: the caller already encapsulated with the developer's
          // public key and pre-shipped the wrapped key. Forward it as-is.
          // The shared secret lives in the proxy's process memory — this
          // MCP is a transparent forwarder and doesn't participate in crypto.
          body.wrapped_encryption_key = wrapped_encryption_key;
          wrappedEncryptionKeyPresent = true;
        } else {
          warning =
            "No PQDB_PRIVATE_KEY set — project created without encryption. " +
            "Set PQDB_PRIVATE_KEY to enable searchable/private columns.";
        }

        const project = await devPost<{
          id: string;
          name: string;
          wrapped_encryption_key?: string | null;
        }>(projectUrl, devToken!, "/v1/projects", body);

        // POST succeeded — now commit the shared secret to auth-state so
        // subsequent CRUD tools can derive per-project encryption keys.
        if (pendingSharedSecret) {
          setCurrentSharedSecret(pendingSharedSecret);
          wrappedEncryptionKeyPresent = true;
        }

        // Auto-select the newly created project
        setCurrentProjectId(project.id);

        return successResult({
          data: {
            project,
            encryption_active: wrappedEncryptionKeyPresent,
            warning,
          },
          error: null,
        });
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
    "Promote (merge) a branch into main. Applies all branch changes to the main database. By default the merge fails if there are active connections to main — set force=true to proceed anyway. Requires PQDB_DEV_TOKEN.",
    {
      project_id: z.string().describe("ID of the project"),
      name: z.string().describe("Name of the branch to merge into main"),
      force: z
        .boolean()
        .optional()
        .describe(
          "If true, promote even when active connections exist on main. Use with caution — active connections will be dropped.",
        ),
    },
    async ({ project_id, name, force }) => {
      const authError = requireDevToken(devToken);
      if (authError) return authError;

      try {
        const result = await devPost<unknown>(
          projectUrl,
          devToken!,
          `/v1/projects/${encodeURIComponent(project_id)}/branches/${encodeURIComponent(name)}/promote`,
          { force: force ?? false },
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
