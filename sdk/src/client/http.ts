/**
 * HTTP client wrapper around native fetch.
 *
 * All methods return { data, error } — never throw.
 * The apikey header is attached to every request.
 * Authorization: Bearer is attached when a JWT is available.
 */
import type { PqdbError, PqdbResponse, HttpRequestOptions } from "./types.js";

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private onRefreshNeeded: (() => Promise<boolean>) | null = null;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  setTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  setAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
  }

  clearTokens(): void {
    this.accessToken = null;
    this.refreshToken = null;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getRefreshToken(): string | null {
    return this.refreshToken;
  }

  setRefreshHandler(handler: () => Promise<boolean>): void {
    this.onRefreshNeeded = handler;
  }

  async request<T>(options: HttpRequestOptions): Promise<PqdbResponse<T>> {
    const headers: Record<string, string> = {
      apikey: this.apiKey,
      ...options.headers,
    };

    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const url = `${this.baseUrl}${options.path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      return {
        data: null,
        error: {
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : "Network request failed",
        },
      };
    }

    if (response.status === 401 && this.refreshToken && this.onRefreshNeeded) {
      const refreshed = await this.onRefreshNeeded();
      if (refreshed) {
        return this.request(options);
      }
    }

    if (!response.ok) {
      return this.parseErrorResponse(response);
    }

    try {
      const data = (await response.json()) as T;
      return { data, error: null };
    } catch {
      return {
        data: null,
        error: {
          code: "PARSE_ERROR",
          message: "Failed to parse response JSON",
        },
      };
    }
  }

  private async parseErrorResponse<T>(
    response: Response,
  ): Promise<PqdbResponse<T>> {
    let error: PqdbError;
    try {
      const body = (await response.json()) as { detail?: string };
      error = {
        code: `HTTP_${response.status}`,
        message: body.detail ?? response.statusText,
      };
    } catch {
      error = {
        code: `HTTP_${response.status}`,
        message: response.statusText,
      };
    }
    return { data: null, error };
  }
}
