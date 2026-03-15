/**
 * Type definitions for the pqdb client SDK.
 */

/** Options for creating a pqdb client. */
export interface PqdbClientOptions {
  /** Master key for ML-KEM encryption. Never transmitted to the server. */
  encryptionKey?: string;
}

/** Credentials for auth operations. */
export interface AuthCredentials {
  email: string;
  password: string;
}

/** Token data returned by successful auth operations. */
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/** Refresh response (no refresh_token returned). */
export interface RefreshTokens {
  access_token: string;
  token_type: string;
}

/** Structured error from the pqdb API or client. */
export interface PqdbError {
  code: string;
  message: string;
}

/** Successful response. */
export interface SuccessResponse<T> {
  data: T;
  error: null;
}

/** Error response. */
export interface ErrorResponse {
  data: null;
  error: PqdbError;
}

/** All SDK methods return this discriminated union — never throw. */
export type PqdbResponse<T> = SuccessResponse<T> | ErrorResponse;

/** Auth method response type. */
export type AuthResponse = PqdbResponse<AuthTokens>;

/** User profile returned by the backend. */
export interface UserProfile {
  id: string;
  email: string;
  role: string;
  email_verified: boolean;
  metadata: Record<string, unknown>;
}

/** User auth response (signup/login) — includes user profile and tokens. */
export interface UserAuthTokens {
  user: UserProfile;
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/** User auth method response type. */
export type UserAuthResponse = PqdbResponse<UserAuthTokens>;

/** Data for updating user metadata. */
export interface UserMetadataUpdate {
  metadata: Record<string, unknown>;
}

/** Options for HTTP requests. */
export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the automatic 401 refresh handler (used by UserAuthClient which manages its own refresh). */
  skipRefresh?: boolean;
}
