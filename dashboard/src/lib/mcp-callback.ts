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
 * Build the redirect URL for the MCP server callback.
 */
export function buildMcpRedirectUrl(
  callbackUrl: string,
  requestId: string,
  token: string,
): string {
  const url = new URL(callbackUrl);
  url.searchParams.set("request_id", requestId);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Handle post-login redirect. If MCP callback params are present and valid,
 * redirect to the MCP server. Otherwise, return false so the caller can
 * navigate to /projects.
 */
export function handleMcpRedirect(accessToken: string): boolean {
  const { mcp_callback, request_id } = getMcpCallbackParams();

  if (!mcp_callback || !request_id) {
    return false;
  }

  if (!isValidMcpCallback(mcp_callback)) {
    return false;
  }

  window.location.href = buildMcpRedirectUrl(
    mcp_callback,
    request_id,
    accessToken,
  );
  return true;
}
