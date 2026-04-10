/**
 * Shared auth state for MCP tool modules.
 *
 * Holds the current developer JWT and project ID, with auto-refresh
 * on 401 responses. All tool modules reference this shared state
 * instead of storing their own copies.
 */

/** Current auth state — mutated by setAuthState and refreshToken. */
let _devToken: string | undefined;
let _projectId: string | undefined;
let _refreshToken: string | undefined;
let _projectUrl: string | undefined;

/**
 * ML-KEM-768 private key loaded from PQDB_PRIVATE_KEY. Used to unwrap
 * per-project encryption keys during pqdb_select_project. Kept in
 * process memory only — never serialized into tool responses or logs.
 */
let _privateKey: Uint8Array | undefined;

/**
 * Current active per-project shared secret, recovered via decapsulate
 * in pqdb_select_project or produced via encapsulate in pqdb_create_project.
 * Used by subsequent CRUD tools to encrypt/decrypt sensitive columns.
 */
let _sharedSecret: Uint8Array | undefined;

/** Whether the dev token has been refreshed at least once. */
let _tokenRefreshed = false;

/** Set the shared auth state. Called during MCP session initialization.
 *  If the token has already been refreshed, keeps the fresh token. */
export function setAuthState(opts: {
  devToken?: string;
  projectId?: string;
  refreshToken?: string;
  projectUrl?: string;
}): void {
  // Don't overwrite a refreshed token with the stale original
  if (!_tokenRefreshed || !_devToken) {
    _devToken = opts.devToken;
  }
  _projectId = opts.projectId;
  _refreshToken = opts.refreshToken;
  _projectUrl = opts.projectUrl;
}

/** Get the current developer token. */
export function getDevToken(): string | undefined {
  return _devToken;
}

/** Get the current project ID. */
export function getProjectId(): string | undefined {
  return _projectId;
}

/** Switch the active project at runtime (used by pqdb_select_project). */
export function setCurrentProjectId(projectId: string): void {
  _projectId = projectId;
}

/**
 * Store the developer's ML-KEM-768 private key in memory.
 * The raw bytes never leave process memory and must never be
 * serialized into tool responses or logs.
 */
export function setCurrentPrivateKey(key: Uint8Array): void {
  _privateKey = key;
}

/** Return the in-memory ML-KEM private key, or undefined if none configured. */
export function getCurrentPrivateKey(): Uint8Array | undefined {
  return _privateKey;
}

/** Clear the in-memory private key (primarily for tests). */
export function clearCurrentPrivateKey(): void {
  _privateKey = undefined;
}

/**
 * Store the active per-project shared secret (32 bytes for ML-KEM-768).
 * Populated by pqdb_create_project (encapsulate) and pqdb_select_project
 * (decapsulate).
 */
export function setCurrentSharedSecret(secret: Uint8Array): void {
  _sharedSecret = secret;
}

/** Return the current active shared secret, if any. */
export function getCurrentSharedSecret(): Uint8Array | undefined {
  return _sharedSecret;
}

/** Clear the active shared secret (e.g. when selecting a plaintext project). */
export function clearCurrentSharedSecret(): void {
  _sharedSecret = undefined;
}

/**
 * Return the current active shared secret encoded as a base64url string
 * (no padding), suitable for passing to the SDK's `deriveKeyPair(string)`.
 * Returns `null` when no shared secret is set.
 *
 * This is the bridge between the per-project shared secret recovered in
 * `pqdb_create_project` / `pqdb_select_project` and the CRUD-tool key
 * derivation path, which consumes a string.
 */
export function getCurrentEncryptionKeyString(): string | null {
  if (!_sharedSecret) return null;
  return bytesToBase64UrlNoPad(_sharedSecret);
}

/** Encode bytes to base64url without padding. */
function bytesToBase64UrlNoPad(bytes: Uint8Array): string {
  // Buffer is available in Node (MCP server runtime); use it for correctness.
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build auth headers — uses apikey if available, otherwise developer JWT + project ID. */
export function buildAuthHeaders(apiKey: string): Record<string, string> {
  if (apiKey) {
    return { apikey: apiKey };
  }
  if (_devToken && _projectId) {
    return {
      Authorization: `Bearer ${_devToken}`,
      "x-project-id": _projectId,
    };
  }
  return {};
}

/**
 * Attempt to refresh the developer JWT using the stored refresh token.
 * Returns true if the refresh succeeded and _devToken was updated.
 */
async function refreshDevToken(): Promise<boolean> {
  if (!_refreshToken || !_projectUrl) {
    return false;
  }

  try {
    const res = await fetch(`${_projectUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: _refreshToken }),
    });

    if (res.ok) {
      const data = (await res.json()) as { access_token: string };
      _devToken = data.access_token;
      _tokenRefreshed = true;
      console.error("[pqdb-mcp] Auto-refreshed developer JWT");
      return true;
    }
  } catch {
    // Refresh failed — caller should handle
  }

  return false;
}

/** Make an authenticated GET request with auto-retry on 401. */
export async function authFetch<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const doFetch = async (): Promise<Response> =>
    fetch(`${projectUrl}${path}`, {
      method: "GET",
      headers: { ...buildAuthHeaders(apiKey), ...extraHeaders },
    });

  let response = await doFetch();

  // Auto-refresh on 401 and retry once
  if (response.status === 401 && !apiKey && _refreshToken) {
    const refreshed = await refreshDevToken();
    if (refreshed) {
      response = await doFetch();
    }
  }

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { detail?: unknown };
      const d = body.detail;
      if (typeof d === "string") {
        detail = d;
      } else if (d && typeof d === "object" && "error" in d) {
        const err = (d as { error: { code?: string; message?: string } }).error;
        detail = err.message ?? err.code ?? response.statusText;
      } else {
        detail = JSON.stringify(d) ?? response.statusText;
      }
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

/** Make an authenticated POST request with auto-retry on 401. */
export async function authPost<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const doFetch = async (): Promise<Response> =>
    fetch(`${projectUrl}${path}`, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(apiKey),
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

  let response = await doFetch();

  // Auto-refresh on 401 and retry once
  if (response.status === 401 && !apiKey && _refreshToken) {
    const refreshed = await refreshDevToken();
    if (refreshed) {
      response = await doFetch();
    }
  }

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = (await response.json()) as { detail?: unknown };
      const d = errorBody.detail;
      if (typeof d === "string") {
        detail = d;
      } else if (d && typeof d === "object" && "error" in d) {
        const err = (d as { error: { code?: string; message?: string } }).error;
        detail = err.message ?? err.code ?? response.statusText;
      } else {
        detail = JSON.stringify(d) ?? response.statusText;
      }
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}
