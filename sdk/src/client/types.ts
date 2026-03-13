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

/** Options for HTTP requests. */
export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}
