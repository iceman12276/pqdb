/**
 * API client for pqdb backend.
 * Handles auth endpoints and auto-attaches JWT Bearer tokens.
 * Automatically refreshes expired access tokens on 401.
 */

import {
  getAccessToken,
  getTokens,
  setTokens,
  clearTokens,
  type TokenPair,
} from "./auth-store";

interface ApiError {
  code: number;
  message: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

interface AccessTokenResponse {
  access_token: string;
  token_type: string;
}

type AuthResult<T> = { data: T; error: null } | { data: null; error: ApiError };

interface FetchResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface ApiClient {
  signup(email: string, password: string): Promise<AuthResult<TokenResponse>>;
  login(email: string, password: string): Promise<AuthResult<TokenResponse>>;
  refresh(refreshToken: string): Promise<AuthResult<AccessTokenResponse>>;
  fetch(path: string, init?: RequestInit): Promise<FetchResult>;
}

export function createApiClient(config: { baseUrl: string }): ApiClient {
  const { baseUrl } = config;

  async function authRequest<T>(
    endpoint: string,
    body: Record<string, string>,
  ): Promise<AuthResult<T>> {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        data: null,
        error: {
          code: response.status,
          message: data.detail ?? "Unknown error",
        },
      };
    }

    return { data: data as T, error: null };
  }

  async function signup(
    email: string,
    password: string,
  ): Promise<AuthResult<TokenResponse>> {
    return authRequest<TokenResponse>("/v1/auth/signup", { email, password });
  }

  async function login(
    email: string,
    password: string,
  ): Promise<AuthResult<TokenResponse>> {
    return authRequest<TokenResponse>("/v1/auth/login", { email, password });
  }

  async function refreshToken(
    rt: string,
  ): Promise<AuthResult<AccessTokenResponse>> {
    return authRequest<AccessTokenResponse>("/v1/auth/refresh", {
      refresh_token: rt,
    });
  }

  async function authenticatedFetch(
    path: string,
    init?: RequestInit,
  ): Promise<FetchResult> {
    const accessToken = getAccessToken();
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });

    // Auto-refresh on 401
    if (response.status === 401 && accessToken) {
      const tokens = getTokens();
      if (tokens?.refresh_token) {
        const refreshResult = await refreshToken(tokens.refresh_token);
        if (refreshResult.data) {
          setTokens({
            access_token: refreshResult.data.access_token,
            refresh_token: tokens.refresh_token,
          });

          // Retry with new token
          const retryHeaders: Record<string, string> = {
            ...(init?.headers as Record<string, string>),
            Authorization: `Bearer ${refreshResult.data.access_token}`,
          };
          const retryResponse = await fetch(`${baseUrl}${path}`, {
            ...init,
            headers: retryHeaders,
          });
          const retryData = retryResponse.ok
            ? await retryResponse.json()
            : null;
          return {
            ok: retryResponse.ok,
            status: retryResponse.status,
            data: retryData,
          };
        } else {
          // Refresh failed — clear tokens
          clearTokens();
          return { ok: false, status: 401, data: null };
        }
      }
    }

    const data = response.ok ? await response.json() : null;
    return { ok: response.ok, status: response.status, data };
  }

  return {
    signup,
    login,
    refresh: refreshToken,
    fetch: authenticatedFetch,
  };
}

// Singleton instance for use throughout the app
export const api = createApiClient({ baseUrl: "http://localhost:8000" });
