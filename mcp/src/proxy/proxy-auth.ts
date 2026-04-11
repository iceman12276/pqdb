/**
 * Proxy OAuth login handler (US-015).
 *
 * Opens the developer's browser to the pqdb Dashboard login page and captures
 * the JWT via a local HTTP callback. Uses execFile (not exec) to avoid shell
 * injection when opening the browser.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import express from "express";
import type { AddressInfo } from "node:net";

export interface ProxyAuthResult {
  devJwt: string;
  refreshToken?: string;
  encryptionKey?: string;
}

export interface ProxyLoginOptions {
  /** Timeout in milliseconds. Defaults to 120_000 (2 minutes). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Start a temporary local Express server, open the browser to the Dashboard
 * login page, and wait for the JWT callback.
 *
 * @param dashboardUrl - Base URL of the pqdb Dashboard (e.g. "https://localhost")
 * @param options - Optional configuration (timeout)
 * @returns The developer JWT and optional refresh/encryption keys
 */
export function proxyLogin(
  dashboardUrl: string,
  options?: ProxyLoginOptions,
): Promise<ProxyAuthResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ProxyAuthResult>((resolve, reject) => {
    const requestId = randomUUID();
    const app = express();
    app.use(express.json());

    app.post("/mcp-auth-complete", (req, res) => {
      const bodyRequestId = req.body?.request_id as string | undefined;
      const token = req.body?.token as string | undefined;

      if (bodyRequestId !== requestId) {
        res.status(400).json({ error: "Invalid request_id" });
        return;
      }

      if (!token) {
        res.status(400).json({ error: "Missing required field: token" });
        return;
      }

      const result: ProxyAuthResult = {
        devJwt: token,
        refreshToken: req.body.refresh_token ?? undefined,
        encryptionKey: req.body.encryption_key ?? undefined,
      };

      res.json({ ok: true });
      clearTimeout(timer);
      server.close();
      resolve(result);
    });

    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const callbackUrl = `http://localhost:${port}/mcp-auth-complete`;
      const loginUrl = new URL("/login", dashboardUrl);
      loginUrl.searchParams.set(
        "mcp_callback",
        callbackUrl,
      );
      loginUrl.searchParams.set("request_id", requestId);

      console.error("[pqdb-proxy] Opening browser for login...");
      openBrowser(loginUrl.toString());
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out. Please restart and try again."));
    }, timeoutMs);
  });
}

/**
 * Open a URL in the user's default browser.
 * Uses execFile (not exec) to prevent shell injection (CWE-78).
 */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(cmd, [url], (err) => {
    if (err) {
      console.error("[pqdb-proxy] Could not open browser:", err.message);
    }
  });
}
