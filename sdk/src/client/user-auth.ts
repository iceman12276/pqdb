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
import { MfaClient } from "./mfa.js";
import type {
  AuthCredentials,
  UserAuthTokens,
  UserAuthResponse,
  UserProfile,
  UserMetadataUpdate,
  RefreshTokens,
  MfaRequiredResponse,
  SetRoleResponse,
  PqdbResponse,
  OAuthOptions,
  OAuthUrlResult,
  OAuthCallbackParams,
  LinkedProvider,
  MagicLinkResult,
  VerifyEmailResult,
  ResendVerificationResult,
  ResetPasswordResult,
  UpdatePasswordResult,
} from "./types.js";

export class UserAuthClient {
  private readonly http: HttpClient;
  private userAccessToken: string | null = null;
  private userRefreshToken: string | null = null;
  private userId: string | null = null;
  readonly mfa: MfaClient;

  constructor(http: HttpClient) {
    this.http = http;
    this.mfa = new MfaClient(
      (opts) => this.userRequest(opts),
      (accessToken, refreshToken, userId) => {
        this.userAccessToken = accessToken;
        this.userRefreshToken = refreshToken;
        this.userId = userId;
      },
    );
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

  async signIn(
    credentials: AuthCredentials,
  ): Promise<PqdbResponse<UserAuthTokens | MfaRequiredResponse>> {
    const result = await this.http.request<UserAuthTokens | MfaRequiredResponse>({
      method: "POST",
      path: "/v1/auth/users/login",
      body: credentials,
    });

    if (result.data && "mfa_required" in result.data && result.data.mfa_required) {
      // MFA required — don't store tokens, return the MFA challenge data
      return result;
    }

    if (result.data && "access_token" in result.data) {
      const tokens = result.data as UserAuthTokens;
      this.userAccessToken = tokens.access_token;
      this.userRefreshToken = tokens.refresh_token;
      this.userId = tokens.user.id;
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

  // ── OAuth ──────────────────────────────────────────────────────────

  async signInWithOAuth(
    provider: string,
    options: OAuthOptions,
  ): Promise<PqdbResponse<OAuthUrlResult>> {
    const encodedRedirect = encodeURIComponent(options.redirectTo);
    const url = `${this.http.getBaseUrl()}/v1/auth/users/oauth/${provider}/authorize?redirect_uri=${encodedRedirect}`;
    return {
      data: { url, provider },
      error: null,
    };
  }

  async handleOAuthCallback(
    params: OAuthCallbackParams,
  ): Promise<PqdbResponse<{ user: UserProfile; access_token: string; refresh_token: string }>> {
    // Store the tokens from the callback
    this.userAccessToken = params.access_token;
    this.userRefreshToken = params.refresh_token;

    // Fetch the user profile to populate user data
    const userResult = await this.userRequest<UserProfile>({
      method: "GET",
      path: "/v1/auth/users/me",
    });

    if (userResult.error) {
      // Clear tokens on failure
      this.userAccessToken = null;
      this.userRefreshToken = null;
      this.userId = null;
      return { data: null, error: userResult.error };
    }

    this.userId = userResult.data!.id;

    return {
      data: {
        user: userResult.data!,
        access_token: params.access_token,
        refresh_token: params.refresh_token,
      },
      error: null,
    };
  }

  async linkOAuth(
    provider: string,
    options: OAuthOptions,
  ): Promise<PqdbResponse<OAuthUrlResult>> {
    return this.userRequest<OAuthUrlResult>({
      method: "POST",
      path: `/v1/auth/users/oauth/${provider}/link`,
      body: { redirect_to: options.redirectTo },
    });
  }

  async unlinkOAuth(
    provider: string,
  ): Promise<PqdbResponse<{ message: string }>> {
    return this.userRequest<{ message: string }>({
      method: "DELETE",
      path: `/v1/auth/users/oauth/${provider}`,
    });
  }

  async getLinkedProviders(): Promise<PqdbResponse<LinkedProvider[]>> {
    return this.userRequest<LinkedProvider[]>({
      method: "GET",
      path: "/v1/auth/users/oauth/providers",
    });
  }

  // ── Magic Link ────────────────────────────────────────────────────

  async signInWithMagicLink(params: { email: string }): Promise<PqdbResponse<MagicLinkResult>> {
    return this.http.request<MagicLinkResult>({
      method: "POST",
      path: "/v1/auth/users/magic-link",
      body: { email: params.email },
    });
  }

  async verifyMagicLink(token: string): Promise<UserAuthResponse> {
    const result = await this.http.request<UserAuthTokens>({
      method: "POST",
      path: "/v1/auth/users/verify-magic-link",
      body: { token },
    });

    if (result.data) {
      this.userAccessToken = result.data.access_token;
      this.userRefreshToken = result.data.refresh_token;
      this.userId = result.data.user.id;
    }

    return result;
  }

  // ── Email Verification ────────────────────────────────────────────

  async verifyEmail(token: string): Promise<PqdbResponse<VerifyEmailResult>> {
    return this.http.request<VerifyEmailResult>({
      method: "POST",
      path: "/v1/auth/users/verify-email",
      body: { token },
    });
  }

  async resendVerification(): Promise<PqdbResponse<ResendVerificationResult>> {
    return this.userRequest<ResendVerificationResult>({
      method: "POST",
      path: "/v1/auth/users/resend-verification",
    });
  }

  // ── Password Reset ────────────────────────────────────────────────

  async resetPassword(params: { email: string }): Promise<PqdbResponse<ResetPasswordResult>> {
    return this.http.request<ResetPasswordResult>({
      method: "POST",
      path: "/v1/auth/users/reset-password",
      body: { email: params.email },
    });
  }

  async updatePassword(params: {
    token: string;
    newPassword: string;
  }): Promise<PqdbResponse<UpdatePasswordResult>> {
    return this.http.request<UpdatePasswordResult>({
      method: "POST",
      path: "/v1/auth/users/update-password",
      body: { token: params.token, new_password: params.newPassword },
    });
  }

  /** Get the current user's ID, or null if not signed in. */
  getUserId(): string | null {
    return this.userId;
  }

  /** Set a user's role. Requires service API key. */
  async setRole(
    userId: string,
    role: string,
  ): Promise<PqdbResponse<SetRoleResponse>> {
    return this.http.request<SetRoleResponse>({
      method: "PUT",
      path: `/v1/auth/users/${userId}/role`,
      body: { role },
    });
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
