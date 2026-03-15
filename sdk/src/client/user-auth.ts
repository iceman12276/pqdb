/**
 * UserAuthClient handles end-user authentication.
 *
 * User tokens are stored separately from developer tokens so both
 * auth states can coexist in the same client instance.
 *
 * User auth requests go through the same HttpClient but use a dedicated
 * internal HTTP helper that manages its own Authorization header.
 */
import type { HttpClient } from "./http.js";
import type {
  AuthCredentials,
  UserAuthTokens,
  UserAuthResponse,
  UserProfile,
  UserMetadataUpdate,
  RefreshTokens,
  PqdbResponse,
} from "./types.js";

export class UserAuthClient {
  private readonly http: HttpClient;
  private userAccessToken: string | null = null;
  private userRefreshToken: string | null = null;
  private userId: string | null = null;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async signUp(credentials: AuthCredentials): Promise<UserAuthResponse> {
    const result = await this.http.request<UserAuthTokens>({
      method: "POST",
      path: "/v1/auth/users/signup",
      body: credentials,
    });

    if (result.data) {
      this.userAccessToken = result.data.access_token;
      this.userRefreshToken = result.data.refresh_token;
      this.userId = result.data.user.id;
    }

    return result;
  }

  async signIn(credentials: AuthCredentials): Promise<UserAuthResponse> {
    const result = await this.http.request<UserAuthTokens>({
      method: "POST",
      path: "/v1/auth/users/login",
      body: credentials,
    });

    if (result.data) {
      this.userAccessToken = result.data.access_token;
      this.userRefreshToken = result.data.refresh_token;
      this.userId = result.data.user.id;
    }

    return result;
  }

  async signOut(): Promise<PqdbResponse<{ message: string }>> {
    const result = await this.userRequest<{ message: string }>({
      method: "POST",
      path: "/v1/auth/users/logout",
      body: { refresh_token: this.userRefreshToken },
    });

    // Clear tokens regardless of server response
    this.userAccessToken = null;
    this.userRefreshToken = null;
    this.userId = null;

    return result;
  }

  async getUser(): Promise<PqdbResponse<UserProfile>> {
    return this.userRequest<UserProfile>({
      method: "GET",
      path: "/v1/auth/users/me",
    });
  }

  async updateUser(data: UserMetadataUpdate): Promise<PqdbResponse<UserProfile>> {
    return this.userRequest<UserProfile>({
      method: "PUT",
      path: "/v1/auth/users/me",
      body: data,
    });
  }

  /** Get the current user's ID, or null if not signed in. */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Make an HTTP request with user-level Authorization header.
   *
   * Handles auto-refresh: on 401, attempts to use the user refresh
   * token to get a new access token, then retries the original request.
   */
  private async userRequest<T>(options: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
  }): Promise<PqdbResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.userAccessToken) {
      headers["Authorization"] = `Bearer ${this.userAccessToken}`;
    }

    const result = await this.http.request<T>({
      ...options,
      headers,
      skipRefresh: true,
    });

    // Handle 401 with user-level auto-refresh
    if (result.error?.code === "HTTP_401" && this.userRefreshToken) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        // Retry with new token
        const retryHeaders: Record<string, string> = {};
        if (this.userAccessToken) {
          retryHeaders["Authorization"] = `Bearer ${this.userAccessToken}`;
        }
        return this.http.request<T>({
          ...options,
          headers: retryHeaders,
          skipRefresh: true,
        });
      }
    }

    return result;
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.userRefreshToken) return false;

    const result = await this.http.request<RefreshTokens>({
      method: "POST",
      path: "/v1/auth/users/refresh",
      body: { refresh_token: this.userRefreshToken },
    });

    if (result.data) {
      this.userAccessToken = result.data.access_token;
      return true;
    }

    return false;
  }
}
