/**
 * MfaClient handles MFA enrollment, verification, challenge, and unenrollment.
 *
 * Uses user-level auth tokens (managed by UserAuthClient).
 */
import type { HttpClient } from "./http.js";
import type {
  MfaEnrollResponse,
  MfaVerifyRequest,
  MfaChallengeRequest,
  MfaUnenrollRequest,
  UserAuthTokens,
  PqdbResponse,
} from "./types.js";

/** Callback to store tokens after successful MFA challenge. */
export type StoreTokensFn = (accessToken: string, refreshToken: string, userId: string) => void;

/** Function to make requests with user-level auth headers. */
export type UserRequestFn = <T>(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}) => Promise<PqdbResponse<T>>;

export class MfaClient {
  private readonly userRequest: UserRequestFn;
  private readonly storeTokens: StoreTokensFn;

  constructor(userRequest: UserRequestFn, storeTokens: StoreTokensFn) {
    this.userRequest = userRequest;
    this.storeTokens = storeTokens;
  }

  async enroll(): Promise<PqdbResponse<MfaEnrollResponse>> {
    return this.userRequest<MfaEnrollResponse>({
      method: "POST",
      path: "/v1/auth/users/mfa/enroll",
    });
  }

  async verify(data: MfaVerifyRequest): Promise<PqdbResponse<unknown>> {
    return this.userRequest<unknown>({
      method: "POST",
      path: "/v1/auth/users/mfa/verify",
      body: data,
    });
  }

  async challenge(data: MfaChallengeRequest): Promise<PqdbResponse<UserAuthTokens>> {
    const result = await this.userRequest<UserAuthTokens>({
      method: "POST",
      path: "/v1/auth/users/mfa/challenge",
      body: data,
    });

    if (result.data) {
      this.storeTokens(
        result.data.access_token,
        result.data.refresh_token,
        result.data.user.id,
      );
    }

    return result;
  }

  async unenroll(data: MfaUnenrollRequest): Promise<PqdbResponse<unknown>> {
    return this.userRequest<unknown>({
      method: "POST",
      path: "/v1/auth/users/mfa/unenroll",
      body: data,
    });
  }
}
