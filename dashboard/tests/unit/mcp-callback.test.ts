import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidMcpCallback,
  buildMcpRedirectUrl,
  getMcpCallbackParams,
  handleMcpRedirect,
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

describe("buildMcpRedirectUrl", () => {
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
    // Use Object.defineProperty to mock window.location.search
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

    // Replicate the getOAuthRedirectUri logic from login-page.tsx
    const redirectUri = `${window.location.origin}/login${window.location.search}`;
    const url = new URL(redirectUri);
    expect(url.searchParams.get("mcp_callback")).toBe(
      "http://localhost:3002/callback",
    );
    expect(url.searchParams.get("request_id")).toBe("abc123");
    expect(url.pathname).toBe("/login");
  });
});

describe("handleMcpRedirect", () => {
  const originalLocation = window.location;

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
  });

  it("redirects to MCP callback when params are valid", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = handleMcpRedirect("my-jwt-token");
    expect(result).toBe(true);
    expect(window.location.href).toContain(
      "http://localhost:3002/callback",
    );
    expect(window.location.href).toContain("token=my-jwt-token");
    expect(window.location.href).toContain("request_id=abc123");
  });

  it("includes encryption_key in redirect URL when provided", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = handleMcpRedirect("my-jwt-token", "enc-key-123");
    expect(result).toBe(true);
    expect(window.location.href).toContain("encryption_key=enc-key-123");
  });

  it("omits encryption_key from redirect URL when not provided", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = handleMcpRedirect("my-jwt-token");
    expect(result).toBe(true);
    expect(window.location.href).not.toContain("encryption_key");
  });

  it("returns false when mcp_callback is missing", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search: "?request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });

  it("returns false when request_id is missing", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search: "?mcp_callback=http%3A%2F%2Flocalhost%3A3002%2Fcallback",
        href: "http://localhost:3000/login",
      },
    });

    const result = handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });

  it("returns false when mcp_callback is non-localhost", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...originalLocation,
        search:
          "?mcp_callback=https%3A%2F%2Fevil.com%2Fsteal&request_id=abc123",
        href: "http://localhost:3000/login",
      },
    });

    const result = handleMcpRedirect("my-jwt-token");
    expect(result).toBe(false);
  });
});
