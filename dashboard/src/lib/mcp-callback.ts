/**
 * Utilities for handling MCP OAuth callback redirects.
 *
 * When the MCP server initiates an OAuth flow, it redirects the user to the
 * Dashboard login page with `mcp_callback` and `request_id` query params.
 * After login, the Dashboard redirects back to the MCP server with the JWT.
 */

export interface McpCallbackParams {
  mcp_callback: string | null;
  request_id: string | null;
}

/**
 * Read mcp_callback and request_id from the current URL search params.
 */
export function getMcpCallbackParams(): McpCallbackParams {
  const params = new URLSearchParams(window.location.search);
  return {
    mcp_callback: params.get("mcp_callback"),
    request_id: params.get("request_id"),
  };
}

/**
 * Validate that a callback URL is safe to redirect to.
 * Only loopback URLs (localhost, 127.0.0.1, ::1) over http/https are allowed
 * to prevent open redirect attacks.
 */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function isValidMcpCallback(callbackUrl: string): boolean {
  try {
    const url = new URL(callbackUrl);
    return ALLOWED_PROTOCOLS.has(url.protocol) && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the redirect URL for the MCP server callback (legacy GET-based).
 * @deprecated Use postMcpToken for ML-DSA-65 tokens which are too large for URL params.
 */
export function buildMcpRedirectUrl(
  callbackUrl: string,
  requestId: string,
  token: string,
  encryptionKey?: string,
): string {
  const url = new URL(callbackUrl);
  url.searchParams.set("request_id", requestId);
  url.searchParams.set("token", token);
  if (encryptionKey) {
    url.searchParams.set("encryption_key", encryptionKey);
  }
  return url.toString();
}

/**
 * POST the token to the MCP server's callback endpoint.
 *
 * ML-DSA-65 tokens are ~4.6KB — too large for URL query params (browsers
 * enforce ~2KB limits, servers often cap at 8KB total URL length).
 * POST-based exchange sends the token in the request body instead.
 *
 * Returns the redirect URL from the MCP server response, or null on failure.
 */
export async function postMcpToken(
  callbackUrl: string,
  requestId: string,
  token: string,
  encryptionKey?: string,
): Promise<string | null> {
  try {
    const body: Record<string, string> = {
      request_id: requestId,
      token,
    };
    if (encryptionKey) {
      body.encryption_key = encryptionKey;
    }

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { redirect_url: string };
    return data.redirect_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Handle post-login redirect. If MCP callback params are present and valid,
 * POST the token to the MCP server and redirect to the returned URL.
 * Otherwise, return false so the caller can navigate to /projects.
 *
 * Uses POST-based token exchange because ML-DSA-65 tokens (~4.6KB) are
 * too large for URL query parameters.
 *
 * @param encryptionKey - Optional unwrapped encryption key to pass to the MCP server.
 *   Only included when the developer logged in with a password and has a project
 *   with a wrapped encryption key.
 */
export async function handleMcpRedirect(
  accessToken: string,
  encryptionKey?: string,
): Promise<boolean> {
  const { mcp_callback, request_id } = getMcpCallbackParams();

  if (!mcp_callback || !request_id) {
    return false;
  }

  if (!isValidMcpCallback(mcp_callback)) {
    return false;
  }

  const redirectUrl = await postMcpToken(
    mcp_callback,
    request_id,
    accessToken,
    encryptionKey,
  );

  if (!redirectUrl) {
    return false;
  }

  window.location.href = redirectUrl;
  return true;
}
