/**
 * Type definitions for the pqdb client SDK.
 */

/** Options for creating a pqdb client. */
export interface PqdbClientOptions {
  /** Master key for ML-KEM encryption. Never transmitted to the server. */
  encryptionKey?: string;
  /** Project UUID — required for roles and policies management. */
  projectId?: string;
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

/** Request body for creating a role. */
export interface CreateRoleRequest {
  name: string;
  description?: string;
}

/** Role as returned by the API. */
export interface Role {
  id: string;
  name: string;
  description: string | null;
  created_at?: string | null;
}

/** Request body for creating an RLS policy. */
export interface CreatePolicyRequest {
  name: string;
  operation: string;
  role: string;
  condition: string;
}

/** RLS policy as returned by the API. */
export interface Policy {
  id: string;
  name: string;
  operation: string;
  role: string;
  condition: string;
}

/** MFA enrollment response. */
export interface MfaEnrollResponse {
  secret: string;
  qr_uri: string;
  recovery_codes: string[];
}

/** MFA verify request. */
export interface MfaVerifyRequest {
  code: string;
}

/** MFA challenge request. */
export interface MfaChallengeRequest {
  ticket: string;
  code: string;
}

/** MFA unenroll request. */
export interface MfaUnenrollRequest {
  code: string;
}

/** Response when signIn requires MFA. */
export interface MfaRequiredResponse {
  mfa_required: true;
  mfa_ticket: string;
}

/** Set role response. */
export interface SetRoleResponse {
  role: string;
}

/** Options for OAuth sign-in / linking. */
export interface OAuthOptions {
  redirectTo: string;
}

/** Result of signInWithOAuth — returns the authorization URL. */
export interface OAuthUrlResult {
  url: string;
  provider: string;
}

/** Parameters from OAuth callback URL fragment. */
export interface OAuthCallbackParams {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  [key: string]: string | undefined;
}

/** A linked OAuth provider identity. */
export interface LinkedProvider {
  provider: string;
  provider_user_id: string;
  email: string;
  linked_at: string;
}

/** Result of magic link request. */
export interface MagicLinkResult {
  message: string;
}

/** Result of email verification. */
export interface VerifyEmailResult {
  message: string;
}

/** Result of resend verification. */
export interface ResendVerificationResult {
  message: string;
}

/** Result of password reset request. */
export interface ResetPasswordResult {
  message: string;
}

/** Result of password update. */
export interface UpdatePasswordResult {
  message: string;
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
