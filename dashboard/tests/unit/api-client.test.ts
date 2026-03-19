import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApiClient } from "~/lib/api-client";
import { setTokens, clearTokens, getTokens } from "~/lib/auth-store";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("api-client", () => {
  let api: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokens();
    api = createApiClient({ baseUrl: "http://localhost:8000" });
  });

  describe("signup", () => {
    it("calls POST /v1/auth/signup and returns tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          access_token: "at",
          refresh_token: "rt",
          token_type: "bearer",
        }),
      });

      const result = await api.signup("test@example.com", "password123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/v1/auth/signup",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "test@example.com",
            password: "password123",
          }),
        }),
      );
      expect(result).toEqual({
        data: { access_token: "at", refresh_token: "rt", token_type: "bearer" },
        error: null,
      });
    });

    it("returns error on 409 conflict", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ detail: "Email already registered" }),
      });

      const result = await api.signup("test@example.com", "password123");

      expect(result).toEqual({
        data: null,
        error: { code: 409, message: "Email already registered" },
      });
    });
  });

  describe("login", () => {
    it("calls POST /v1/auth/login and returns tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "at",
          refresh_token: "rt",
          token_type: "bearer",
        }),
      });

      const result = await api.login("test@example.com", "password123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/v1/auth/login",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "test@example.com",
            password: "password123",
          }),
        }),
      );
      expect(result).toEqual({
        data: { access_token: "at", refresh_token: "rt", token_type: "bearer" },
        error: null,
      });
    });

    it("returns error on 401 invalid credentials", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Invalid credentials" }),
      });

      const result = await api.login("test@example.com", "wrong");

      expect(result).toEqual({
        data: null,
        error: { code: 401, message: "Invalid credentials" },
      });
    });

    it("extracts error.message from app error format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: { code: "VALIDATION_ERROR", message: "Invalid email format" },
        }),
      });

      const result = await api.login("bad", "password123");

      expect(result).toEqual({
        data: null,
        error: { code: 400, message: "Invalid email format" },
      });
    });

    it("prefers error.message over detail when both present", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          error: { code: "VALIDATION_ERROR", message: "App-level error" },
          detail: "FastAPI detail",
        }),
      });

      const result = await api.login("test@example.com", "password123");

      expect(result).toEqual({
        data: null,
        error: { code: 422, message: "App-level error" },
      });
    });
  });

  describe("refresh", () => {
    it("calls POST /v1/auth/refresh and returns new access token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-at",
          token_type: "bearer",
        }),
      });

      const result = await api.refresh("old-rt");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/v1/auth/refresh",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: "old-rt" }),
        }),
      );
      expect(result).toEqual({
        data: { access_token: "new-at", token_type: "bearer" },
        error: null,
      });
    });
  });

  describe("authenticated requests", () => {
    it("attaches Authorization header when tokens exist", async () => {
      setTokens({ access_token: "my-token", refresh_token: "rt" });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ projects: [] }),
      });

      await api.fetch("/v1/projects");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/v1/projects",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer my-token",
          }),
        }),
      );
    });

    it("does not attach Authorization header when no tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await api.fetch("/v1/projects");

      const callHeaders = mockFetch.mock.calls[0][1]?.headers ?? {};
      expect(callHeaders).not.toHaveProperty("Authorization");
    });

    it("auto-refreshes on 401 and retries the request", async () => {
      setTokens({ access_token: "expired-at", refresh_token: "valid-rt" });

      // First call: 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Token expired" }),
      });

      // Refresh call: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-at",
          token_type: "bearer",
        }),
      });

      // Retry original call: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ projects: ["p1"] }),
      });

      const result = await api.fetch("/v1/projects");

      expect(mockFetch).toHaveBeenCalledTimes(3);
      // Verify refresh was called
      expect(mockFetch.mock.calls[1][0]).toBe(
        "http://localhost:8000/v1/auth/refresh",
      );
      // Verify retry used new token
      expect(mockFetch.mock.calls[2][1]?.headers?.Authorization).toBe(
        "Bearer new-at",
      );
      expect(result).toEqual({
        ok: true,
        status: 200,
        data: { projects: ["p1"] },
      });
    });

    it("clears tokens and does not retry when refresh fails", async () => {
      setTokens({ access_token: "expired-at", refresh_token: "expired-rt" });

      // First call: 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Token expired" }),
      });

      // Refresh call: also 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Refresh token expired" }),
      });

      const result = await api.fetch("/v1/projects");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(getTokens()).toBeNull();
      expect(result).toEqual({
        ok: false,
        status: 401,
        data: null,
      });
    });
  });
});
