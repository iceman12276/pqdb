/**
 * AuthClient handles signUp, signIn, signOut, and token refresh.
 *
 * Tokens are stored in memory (not localStorage) for SSR safety.
 */
import type { HttpClient } from "./http.js";
import { UserAuthClient } from "./user-auth.js";
import { RolesClient } from "./roles.js";
import { PoliciesClient } from "./policies.js";
import type {
  AuthCredentials,
  AuthTokens,
  RefreshTokens,
  AuthResponse,
} from "./types.js";

export class AuthClient {
  private readonly http: HttpClient;
  readonly users: UserAuthClient;
  readonly roles: RolesClient;
  readonly policies: PoliciesClient;

  constructor(http: HttpClient, projectId?: string) {
    this.http = http;
    this.users = new UserAuthClient(http);
    this.roles = new RolesClient(http, projectId ?? "");
    this.policies = new PoliciesClient(http);

    // Register the refresh handler so HTTP client can auto-refresh on 401
    this.http.setRefreshHandler(() => this.tryRefresh());
  }

  async signUp(credentials: AuthCredentials): Promise<AuthResponse> {
    const result = await this.http.request<AuthTokens>({
      method: "POST",
      path: "/v1/auth/signup",
      body: credentials,
    });

    if (result.data) {
      this.http.setTokens(result.data.access_token, result.data.refresh_token);
    }

    return result;
  }

  async signIn(credentials: AuthCredentials): Promise<AuthResponse> {
    const result = await this.http.request<AuthTokens>({
      method: "POST",
      path: "/v1/auth/login",
      body: credentials,
    });

    if (result.data) {
      this.http.setTokens(result.data.access_token, result.data.refresh_token);
    }

    return result;
  }

  signOut(): void {
    this.http.clearTokens();
  }

  private async tryRefresh(): Promise<boolean> {
    const refreshToken = this.http.getRefreshToken();
    if (!refreshToken) return false;

    // Temporarily clear the refresh handler to avoid infinite loops
    this.http.setRefreshHandler(async () => false);

    const result = await this.http.request<RefreshTokens>({
      method: "POST",
      path: "/v1/auth/refresh",
      body: { refresh_token: refreshToken },
    });

    // Restore the refresh handler
    this.http.setRefreshHandler(() => this.tryRefresh());

    if (result.data) {
      this.http.setAccessToken(result.data.access_token);
      return true;
    }

    return false;
  }
}
