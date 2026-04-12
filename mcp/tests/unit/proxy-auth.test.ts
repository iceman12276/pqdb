/**
 * Unit tests for proxyLogin (US-015).
 *
 * Verifies the proxy OAuth login handler:
 * - Starts an Express server on a random port
 * - Opens the browser to the dashboard login page
 * - Handles POST /mcp-auth-complete callback
 * - Validates request_id
 * - Times out after configured duration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

// Mock child_process.execFile before importing the module under test.
// NOTE: We use execFile (NOT exec) — it avoids shell injection by design.
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _cb: (err: Error | null) => void) => {
    // no-op: don't actually open a browser
  }),
}));

import { proxyLogin, type ProxyAuthResult } from "../../src/proxy/proxy-auth.js";
import { execFile } from "node:child_process";

const mockedExecFile = vi.mocked(execFile);

/**
 * Helper: POST JSON to a given URL.
 * Uses raw http.request to avoid adding a test dependency.
 */
function postJson(url: string, body: Record<string, unknown>): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * Helper: send an OPTIONS preflight request.
 */
function optionsRequest(
  url: string,
  origin: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Extract the port from the login URL that was passed to execFile.
 */
function extractPortFromExecFile(): number {
  const call = mockedExecFile.mock.calls[0];
  const loginUrl = call[1][0]; // second arg is the array of args, first element is the URL
  const parsed = new URL(new URL(loginUrl).searchParams.get("mcp_callback")!);
  return parseInt(parsed.port, 10);
}

/**
 * Extract the request_id from the login URL that was passed to execFile.
 */
function extractRequestIdFromExecFile(): string {
  const call = mockedExecFile.mock.calls[0];
  const loginUrl = call[1][0];
  return new URL(loginUrl).searchParams.get("request_id")!;
}

describe("proxyLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves with JWT on valid callback", async () => {
    const dashboardUrl = "http://localhost:3000";

    // Start proxyLogin — it will open a server and wait for callback
    const loginPromise = proxyLogin(dashboardUrl);

    // Wait for execFile to be called (server is up)
    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();

    // POST the callback with a valid request_id
    const response = await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "jwt-token-abc",
      refresh_token: "refresh-xyz",
      encryption_key: "enc-key-123",
    });

    expect(response.statusCode).toBe(200);

    const result = await loginPromise;
    expect(result).toEqual({
      devJwt: "jwt-token-abc",
      refreshToken: "refresh-xyz",
      encryptionKey: "enc-key-123",
    });
  });

  it("returns 400 for mismatched request_id", async () => {
    const dashboardUrl = "http://localhost:3000";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();

    // POST with a WRONG request_id
    const response = await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: "wrong-id",
      token: "jwt-token-abc",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/request_id/i);

    // Now send the correct one so the promise resolves and the server shuts down
    const requestId = extractRequestIdFromExecFile();
    await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "jwt-token-abc",
    });
    await loginPromise;
  });

  it("times out after the configured duration", async () => {
    const dashboardUrl = "http://localhost:3000";

    // Use a very short timeout for the test
    const loginPromise = proxyLogin(dashboardUrl, { timeoutMs: 100 });

    await expect(loginPromise).rejects.toThrow(/timed? out/i);
  });

  it("handles callback with only token (no refresh_token or encryption_key)", async () => {
    const dashboardUrl = "http://localhost:3000";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();

    const response = await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "jwt-only",
    });

    expect(response.statusCode).toBe(200);

    const result = await loginPromise;
    expect(result).toEqual({
      devJwt: "jwt-only",
      refreshToken: undefined,
      encryptionKey: undefined,
    });
  });

  it("returns 400 when token is missing from callback body", async () => {
    const dashboardUrl = "http://localhost:3000";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();

    // POST without a token field
    const response = await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/token/i);

    // Clean up: send a valid callback so the server shuts down
    await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "cleanup-jwt",
    });
    await loginPromise;
  });

  it("opens the browser with the correct login URL", async () => {
    const dashboardUrl = "https://my-dashboard.example.com";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    // Verify execFile was called with the right command
    const call = mockedExecFile.mock.calls[0];
    const cmd = call[0];
    const loginUrl = call[1][0];

    // On Linux, should use xdg-open
    if (process.platform === "linux") {
      expect(cmd).toBe("xdg-open");
    } else if (process.platform === "darwin") {
      expect(cmd).toBe("open");
    }

    const parsed = new URL(loginUrl);
    expect(parsed.origin).toBe("https://my-dashboard.example.com");
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.has("mcp_callback")).toBe(true);
    expect(parsed.searchParams.has("request_id")).toBe(true);

    // The callback URL should point to localhost with a port
    const callbackUrl = new URL(parsed.searchParams.get("mcp_callback")!);
    expect(callbackUrl.hostname).toBe("localhost");
    expect(callbackUrl.pathname).toBe("/mcp-auth-complete");

    // Clean up
    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();
    await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "cleanup",
    });
    await loginPromise;
  });

  it("returns redirect_url pointing to the dashboard on successful callback", async () => {
    const dashboardUrl = "https://localhost:8443";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();

    const response = await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "jwt-token",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.redirect_url).toBe("https://localhost:8443/projects");

    await loginPromise;
  });

  it("sets CORS headers so the dashboard can POST cross-origin", async () => {
    const dashboardUrl = "https://localhost:8443";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();

    // Preflight OPTIONS should succeed with CORS headers
    const preflight = await optionsRequest(
      `http://localhost:${port}/mcp-auth-complete`,
      dashboardUrl,
    );
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(dashboardUrl);
    expect(preflight.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(preflight.headers["access-control-allow-headers"]).toMatch(/Content-Type/i);

    // Clean up — actual POST so the promise resolves
    await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "jwt-token",
    });
    await loginPromise;
  });

  it("shuts down the Express server after successful callback", async () => {
    const dashboardUrl = "http://localhost:3000";
    const loginPromise = proxyLogin(dashboardUrl);

    await vi.waitFor(() => {
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    const port = extractPortFromExecFile();
    const requestId = extractRequestIdFromExecFile();

    await postJson(`http://localhost:${port}/mcp-auth-complete`, {
      request_id: requestId,
      token: "jwt-token",
    });

    await loginPromise;

    // The server should be closed — another request should fail
    await expect(
      postJson(`http://localhost:${port}/mcp-auth-complete`, {
        request_id: requestId,
        token: "jwt-token",
      }),
    ).rejects.toThrow(); // ECONNREFUSED
  });
});
