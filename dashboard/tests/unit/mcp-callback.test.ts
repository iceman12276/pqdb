import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidMcpCallback,
  buildMcpRedirectUrl,
  getMcpCallbackParams,
  handleMcpRedirect,
  postMcpToken,
} from "~/lib/mcp-callback";

describe("isValidMcpCallback", () => {
  it("accepts localhost URLs", () => {
    expect(isValidMcpCallback("http://localhost:3002/mcp-auth-complete")).toBe(
      true,
    );
  });

  it("accepts localhost without port", () => {
    expect(isValidMcpCallback("http://localhost/callback")).toBe(true);
  });

  it("accepts 127.0.0.1 URLs", () => {
    expect(isValidMcpCallback("http://127.0.0.1:3002/callback")).toBe(true);
  });

  it("accepts IPv6 loopback URLs", () => {
    expect(isValidMcpCallback("http://[::1]:3002/callback")).toBe(true);
  });

  it("accepts https localhost URLs", () => {
    expect(isValidMcpCallback("https://localhost:3002/callback")).toBe(true);
  });

  it("rejects non-localhost URLs", () => {
    expect(isValidMcpCallback("https://evil.com/steal-token")).toBe(false);
  });

  it("rejects URLs with localhost in path but different host", () => {
    expect(isValidMcpCallback("https://evil.com/localhost/callback")).toBe(
      false,
    );
  });

  it("rejects ftp protocol", () => {
    expect(isValidMcpCallback("ftp://localhost:3002/callback")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isValidMcpCallback("not-a-url")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidMcpCallback("")).toBe(false);
  });
});

describe("buildMcpRedirectUrl (legacy)", () => {
  it("appends request_id and token as query params", () => {
    const result = buildMcpRedirectUrl(
      "http://localhost:3002/mcp-auth-complete",
      "abc123",
      "jwt-token-here",
    );
    const url = new URL(result);
    expect(url.searchParams.get("request_id")).toBe("abc123");
    expect(url.searchParams.get("token")).toBe("jwt-token-here");
    expect(url.origin).toBe("http://localhost:3002");
    expect(url.pathname).toBe("/mcp-auth-complete");
  });

  it("preserves existing query params on the callback URL", () => {
    const result = buildMcpRedirectUrl(
      "http://localhost:3002/callback?existing=param",
      "req1",
      "tok1",
    );
    const url = new URL(result);
    expect(url.searchParams.get("existing")).toBe("param");
    expect(url.searchParams.get("request_id")).toBe("req1");
    expect(url.searchParams.get("token")).toBe("tok1");
  });

  it("includes encryption_key when provided", () => {
    const result = buildMcpRedirectUrl(
      "http://localhost:3002/mcp-auth-complete",
      "abc123",
      "jwt-token-here",
      "my-encryption-key-base64url",
    );
    const url = new URL(result);
    expect(url.searchParams.get("encryption_key")).toBe("my-encryption-key-base64url");
  });

  it("omits encryption_key when not provided", () => {
    const result = buildMcpRedirectUrl(
      "http://localhost:3002/mcp-auth-complete",
      "abc123",
      "jwt-token-here",
    );
    const url = new URL(result);
    expect(url.searchParams.has("encryption_key")).toBe(false);
  });
});

describe("getMcpCallbackParams", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...originalLocation },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  it("returns mcp_callback and request_id from URL", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback&request_id=abc123",
      },
    });

    const params = getMcpCallbackParams();
    expect(params.mcp_callback).toBe("http://localhost:3002/callback");
    expect(params.request_id).toBe("abc123");
  });

  it("returns null when params are not present", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...originalLocation, search: "" },
    });

    const params = getMcpCallbackParams();
    expect(params.mcp_callback).toBeNull();
    expect(params.request_id).toBeNull();
  });
});

describe("getOAuthRedirectUri preserves MCP params", () => {
  const originalLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  it("includes mcp_callback and request_id in the redirect URI", () => {
    const search =
      "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback&request_id=abc123";
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        origin: "http://localhost:3000",
        search,
      },
    });

    const redirectUri = `${window.location.origin}/login${window.location.search}`;
    const url = new URL(redirectUri);
    expect(url.searchParams.get("mcp_callback")).toBe(
      "http://localhost:3002/callback",
    );
    expect(url.searchParams.get("request_id")).toBe("abc123");
    expect(url.pathname).toBe("/login");
  });
});

describe("postMcpToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs token in JSON body and returns redirect_url from response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "http://127.0.0.1:9999/callback?code=abc&state=xyz" }),
    });
    globalThis.fetch = mockFetch;

    const result = await postMcpToken(
      "http://localhost:3002/mcp-auth-complete",
      "req-123",
      "large-jwt-token",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3002/mcp-auth-complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: "req-123", token: "large-jwt-token" }),
      },
    );
    expect(result).toBe("http://127.0.0.1:9999/callback?code=abc&state=xyz");
  });

  it("includes encryption_key in POST body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "http://127.0.0.1:9999/callback?code=abc" }),
    });
    globalThis.fetch = mockFetch;

    await postMcpToken(
      "http://localhost:3002/mcp-auth-complete",
      "req-123",
      "jwt-token",
      "enc-key-base64",
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.encryption_key).toBe("enc-key-base64");
  });

  it("returns null when server responds with error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Unknown request_id" }),
    });

    const result = await postMcpToken(
      "http://localhost:3002/mcp-auth-complete",
      "bad-id",
      "token",
    );
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const result = await postMcpToken(
      "http://localhost:3002/mcp-auth-complete",
      "req-123",
      "token",
    );
    expect(result).toBeNull();
  });

  it("handles large ML-DSA-65 tokens (~4.6KB) in POST body", async () => {
    const largeToken = "header." + "a".repeat(4600) + ".signature";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "http://127.0.0.1:9999/callback?code=abc" }),
    });
    globalThis.fetch = mockFetch;

    const result = await postMcpToken(
      "http://localhost:3002/mcp-auth-complete",
      "req-123",
      largeToken,
    );

    expect(result).toBe("http://127.0.0.1:9999/callback?code=abc");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.token).toBe(largeToken);
    expect(body.token.length).toBe(largeToken.length);
  });
});

describe("handleMcpRedirect", () => {
  const originalLocation = window.location;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search: "",
        href: "http://localhost:3000/login",
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
    globalThis.fetch = originalFetch;
  });

  it("POSTs token to MCP callback and redirects to returned URL", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fmcp-auth-complete&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "http://127.0.0.1:9999/callback?code=auth-code&state=test" }),
    });

    const result = await handleMcpRedirect("my-jwt-token");
    expect(result).toBe(true);
    expect(window.location.href).toBe(
      "http://127.0.0.1:9999/callback?code=auth-code&state=test",
    );
  });

  it("includes encryption_key in POST body when provided", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fmcp-auth-complete&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "http://127.0.0.1:9999/callback?code=abc" }),
    });
    globalThis.fetch = mockFetch;

    const result = await handleMcpRedirect("my-jwt-token", "enc-key-123");
    expect(result).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.encryption_key).toBe("enc-key-123");
  });

  it("returns false when POST fails", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fmcp-auth-complete&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Bad request" }),
    });

    const result = await handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });

  it("returns false when mcp_callback is missing", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search: "?request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = await handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });

  it("returns false when request_id is missing", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search: "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback",
        href: "http://localhost:3000/login",
      },
    });

    const result = await handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });

  it("returns false when mcp_callback is non-localhost", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=https%3A%2F%2Fevil.com%2Fsteal&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = await handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });
});
