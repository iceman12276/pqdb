/**
 * OAuth provider for the pqdb MCP server.
 *
 * Implements OAuthServerProvider to support the MCP OAuth flow where:
 * 1. Claude Code connects and gets 401
 * 2. Claude Code opens browser to /authorize
 * 3. MCP server redirects to Dashboard login
 * 4. Dashboard redirects back with developer JWT
 * 5. MCP server returns JWT as access_token to Claude Code
 */
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** Stored state for a pending authorization (between /authorize and callback). */
interface PendingAuth {
  codeChallenge: string;
  redirectUri: string;
  state: string | undefined;
  clientId: string;
  scopes: string[];
}

/** Stored state for an issued authorization code (between callback and /token). */
interface AuthCodeData {
  devJwt: string;
  codeChallenge: string;
  clientId: string;
  scopes: string[];
  encryptionKey: string | undefined;
}

/** Stored session for a verified access token. */
interface SessionData {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  encryptionKey: string | undefined;
}

export interface PqdbOAuthProviderOptions {
  /** Dashboard URL for login redirects (e.g. http://localhost:3000). */
  dashboardUrl: string;
  /** MCP server's own URL (e.g. http://localhost:3002). */
  mcpServerUrl: string;
  /** Backend API URL (e.g. http://localhost:8000). */
  projectUrl: string;
}

/**
 * In-memory clients store that auto-approves dynamic registration.
 * Claude Code uses dynamic client registration, so we store whatever it registers.
 */
export class PqdbClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    this.clients.set(client.client_id, client);
    return client;
  }
}

/**
 * OAuth provider that bridges Claude Code's OAuth flow to the pqdb Dashboard login.
 *
 * The key insight: we don't issue our own tokens. The developer JWT from the
 * pqdb backend IS the access token. The OAuth dance is just a way to get that
 * JWT to Claude Code via browser-based login.
 */
export class PqdbOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PqdbClientsStore;

  /** Pending auths waiting for the Dashboard callback. Keyed by request_id. */
  private pendingAuths = new Map<string, PendingAuth>();
  /** Auth codes waiting to be exchanged for tokens. Keyed by code. */
  private authCodes = new Map<string, AuthCodeData>();
  /** Verified sessions. Keyed by access token (the dev JWT). */
  private sessions = new Map<string, SessionData>();

  private readonly dashboardUrl: string;
  private readonly mcpServerUrl: string;
  private readonly projectUrl: string;
  /** Refresh token from the dashboard — used to auto-refresh expired JWTs. */
  private refreshToken: string | undefined;

  constructor(options: PqdbOAuthProviderOptions) {
    this.clientsStore = new PqdbClientsStore();
    this.dashboardUrl = options.dashboardUrl;
    this.mcpServerUrl = options.mcpServerUrl;
    this.projectUrl = options.projectUrl;
  }

  /** Store the refresh token received from the dashboard during auth completion. */
  setRefreshToken(token: string): void {
    this.refreshToken = token;
  }

  /** Get the stored refresh token. */
  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  /** Update a session to use a new access token (after refresh).
   *  Keeps the old token valid so existing client connections don't break. */
  updateSessionToken(oldToken: string, newToken: string): void {
    const session = this.sessions.get(oldToken);
    if (session) {
      // Keep old token valid (client still sends it) AND add new token
      this.sessions.set(newToken, { ...session });
    }
  }

  /**
   * Begins authorization by redirecting to Dashboard login.
   *
   * Instead of showing our own login page, we redirect to the Dashboard
   * with a callback URL. The Dashboard will authenticate the developer
   * and redirect back to our /mcp-auth-complete endpoint with the JWT.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const requestId = randomUUID();

    this.pendingAuths.set(requestId, {
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      clientId: client.client_id,
      scopes: params.scopes ?? [],
    });

    // Build callback URL for the Dashboard to redirect back to us
    const callbackUrl = `${this.mcpServerUrl}/mcp-auth-complete`;

    // Redirect to Dashboard login with callback info
    const loginUrl = new URL("/login", this.dashboardUrl);
    loginUrl.searchParams.set("mcp_callback", callbackUrl);
    loginUrl.searchParams.set("request_id", requestId);

    res.redirect(loginUrl.toString());
  }

  /**
   * Returns the PKCE code challenge for a given authorization code.
   * Called by the SDK's token handler to verify the code verifier.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeData = this.authCodes.get(authorizationCode);
    if (!codeData) {
      throw new Error("Invalid authorization code");
    }
    return codeData.codeChallenge;
  }

  /**
   * Exchanges an authorization code for tokens.
   * Returns the developer JWT as the access_token.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const codeData = this.authCodes.get(authorizationCode);
    if (!codeData) {
      throw new Error("Invalid authorization code");
    }

    if (codeData.clientId !== client.client_id) {
      throw new Error(
        `Authorization code was not issued to this client: ${codeData.clientId} != ${client.client_id}`,
      );
    }

    // Consume the code (one-time use)
    this.authCodes.delete(authorizationCode);

    // Store the session so we can verify the token later
    this.sessions.set(codeData.devJwt, {
      clientId: client.client_id,
      scopes: codeData.scopes,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      encryptionKey: codeData.encryptionKey,
    });

    return {
      access_token: codeData.devJwt,
      token_type: "bearer",
      expires_in: 86400, // 24 hours
    };
  }

  /**
   * Refresh token exchange — calls the backend to get a fresh JWT,
   * then issues a new opaque session token to Claude Code.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    if (!this.refreshToken) {
      throw new Error("No refresh token available");
    }

    // Call backend to get a fresh developer JWT
    const res = await fetch(`${this.projectUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });

    if (!res.ok) {
      throw new Error("Backend token refresh failed");
    }

    const data = (await res.json()) as { access_token: string };
    const freshJwt = data.access_token;

    // Generate an opaque session token for Claude Code
    const sessionToken = randomUUID();

    // Find the existing session for this client to preserve encryption key
    let encryptionKey: string | undefined;
    for (const [, session] of this.sessions) {
      if (session.clientId === client.client_id) {
        encryptionKey = session.encryptionKey;
        break;
      }
    }

    // Store new session
    this.sessions.set(sessionToken, {
      clientId: client.client_id,
      scopes: _scopes ?? [],
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      encryptionKey,
    });

    // Update auth-state so tool modules use the fresh JWT
    const { setAuthState } = await import("./auth-state.js");
    setAuthState({
      devToken: freshJwt,
      projectUrl: this.projectUrl,
      refreshToken: this.refreshToken,
    });

    console.error("[pqdb-mcp] OAuth token refreshed successfully");

    return {
      access_token: sessionToken,
      token_type: "bearer",
      expires_in: 86400,
    };
  }

  /**
   * Verifies an access token (the developer JWT) and returns AuthInfo.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      throw new Error("Invalid or expired token");
    }

    return {
      token,
      clientId: session.clientId,
      scopes: session.scopes,
      expiresAt: Math.floor(session.expiresAt / 1000),
    };
  }

  /**
   * Revoke a token by removing it from the sessions store.
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.sessions.delete(request.token);
  }

  /**
   * Get the OAuth-provided encryption key for a session (by access token).
   * Returns undefined if no key was provided during the OAuth flow.
   */
  getSessionEncryptionKey(token: string): string | undefined {
    return this.sessions.get(token)?.encryptionKey;
  }

  // --- Methods used by the /mcp-auth-complete callback endpoint ---

  /**
   * Get a pending auth by request_id. Used by the callback handler
   * to verify the request is legitimate.
   */
  getPendingAuth(requestId: string): PendingAuth | undefined {
    return this.pendingAuths.get(requestId);
  }

  /**
   * Complete an authorization after the Dashboard callback.
   *
   * Validates the stored redirect_uri against the registered client's
   * allowlisted redirect_uris, generates an auth code, and returns a
   * fully-formed redirect URL string. Returns undefined if the
   * request_id is unknown or the redirect_uri fails validation.
   *
   * The redirect URL is built entirely from server-controlled data
   * (registered client redirect_uris + generated auth code + stored state)
   * to prevent open redirect attacks (CWE-601).
   */
  async completeAuthorization(
    requestId: string,
    devJwt: string,
    encryptionKey?: string,
  ): Promise<string | undefined> {
    const pending = this.pendingAuths.get(requestId);
    if (!pending) {
      return undefined;
    }

    // Consume the pending auth
    this.pendingAuths.delete(requestId);

    // Validate redirect_uri against the client's registered redirect_uris.
    const client = await this.clientsStore.getClient(pending.clientId);
    if (!client) {
      return undefined;
    }

    // Find the matching registered redirect_uri from the client's allowlist.
    // Use strict equality — the URI stored during /authorize must exactly
    // match one of the client's registered URIs.
    const allowedUri = client.redirect_uris.find(
      (uri) => uri === pending.redirectUri,
    );
    if (!allowedUri) {
      return undefined;
    }

    // Generate authorization code
    const code = randomUUID();
    this.authCodes.set(code, {
      devJwt,
      codeChallenge: pending.codeChallenge,
      clientId: pending.clientId,
      scopes: pending.scopes,
      encryptionKey,
    });

    // Build the redirect URL from the allowlisted base URI
    const target = new URL(allowedUri);
    target.searchParams.set("code", code);
    if (pending.state) {
      target.searchParams.set("state", pending.state);
    }

    return target.toString();
  }
}
