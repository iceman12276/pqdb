/**
 * Express app factory for the pqdb MCP server with OAuth + StreamableHTTP transport.
 *
 * Separated from cli.ts so the app can be tested with supertest.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { PqdbOAuthProvider } from "./oauth-provider.js";
import { createPqdbMcpServer } from "./server.js";
import { setAuthState } from "./auth-state.js";
import type { ServerConfig } from "./config.js";

/**
 * Perform a redirect to a URL that has been validated against the OAuth client's
 * registered redirect_uris allowlist. This is a separate function to isolate the
 * redirect from the request object, satisfying static taint analysis.
 *
 * SECURITY: The `url` parameter MUST only be called with values returned by
 * PqdbOAuthProvider.completeAuthorization(), which validates the redirect URI
 * against the client's registered redirect_uris before constructing the URL.
 */
function performSafeRedirect(res: Response, url: string): void {
  res.redirect(url);
}

export interface HttpAppOptions {
  /** Dashboard URL for login redirects. */
  dashboardUrl: string;
  /** MCP server's own base URL (e.g. http://localhost:3002). */
  mcpServerUrl: string;
  /** pqdb API backend URL. */
  projectUrl: string;
  /** Optional API key — when absent, tools that need it will fail gracefully. */
  apiKey?: string;
  /** Optional encryption key for client-side decryption. */
  encryptionKey?: string;
}

export interface HttpAppResult {
  app: Express;
  provider: PqdbOAuthProvider;
}

/**
 * Creates the Express app with:
 * - OAuth auth router (metadata, authorize, token, register)
 * - Bearer auth middleware on /mcp endpoints
 * - /mcp-auth-complete callback for Dashboard redirects
 * - StreamableHTTP transport for MCP protocol
 */
export function createMcpHttpApp(options: HttpAppOptions): Express {
  const { dashboardUrl, mcpServerUrl } = options;
  const issuerUrl = new URL(mcpServerUrl);

  const provider = new PqdbOAuthProvider({ dashboardUrl, mcpServerUrl, projectUrl: options.projectUrl });

  const app = express();
  app.use(express.json());

  // CORS for POST-based MCP OAuth token exchange (dashboard → MCP server)
  app.use("/mcp-auth-complete", (req, res, next) => {
    res.header("Access-Control-Allow-Origin", dashboardUrl);
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // --- OAuth routes (metadata, authorize, token, register) ---
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
    }),
  );

  // --- Dashboard callback endpoint ---
  // After the developer logs in on the Dashboard, it redirects here with the JWT.
  //
  // POST-based exchange (primary): Dashboard POSTs token in JSON body and receives
  // the redirect URL in the response. Required for ML-DSA-65 tokens (~4.6KB)
  // which are too large for URL query parameters.
  //
  // GET-based exchange (legacy): Token passed in query params. Kept for backward
  // compatibility with smaller tokens.
  async function handleAuthComplete(
    requestId: string | undefined,
    token: string | undefined,
    encryptionKey: string | undefined,
    refreshToken: string | undefined,
    res: Response,
    method: "GET" | "POST",
  ): Promise<void> {
    if (!requestId || !token) {
      res.status(400).json({
        error: "Missing required parameters: request_id and token",
      });
      return;
    }

    // Store refresh token for auto-refresh
    if (refreshToken) {
      provider.setRefreshToken(refreshToken);
    }

    const redirectUrl = await provider.completeAuthorization(
      requestId,
      token,
      encryptionKey,
    );
    if (!redirectUrl) {
      res.status(400).json({
        error: "Unknown or expired request_id, or redirect URI not registered",
      });
      return;
    }

    if (method === "POST") {
      // POST: return the redirect URL in JSON body (Dashboard handles redirect)
      res.json({ redirect_url: redirectUrl });
    } else {
      // GET: redirect directly (legacy flow)
      performSafeRedirect(res, redirectUrl);
    }
  }

  app.post("/mcp-auth-complete", async (req: Request, res: Response) => {
    const requestId = req.body?.request_id as string | undefined;
    const token = req.body?.token as string | undefined;
    const encryptionKey = req.body?.encryption_key as string | undefined;
    const refreshToken = req.body?.refresh_token as string | undefined;
    await handleAuthComplete(requestId, token, encryptionKey, refreshToken, res, "POST");
  });

  app.get("/mcp-auth-complete", async (req: Request, res: Response) => {
    const requestId = req.query.request_id as string | undefined;
    const token = req.query.token as string | undefined;
    const encryptionKey = req.query.encryption_key as string | undefined;
    await handleAuthComplete(requestId, token, encryptionKey, undefined, res, "GET");
  });

  // --- Bearer auth middleware for MCP endpoints ---
  const authMiddleware = requireBearerAuth({
    verifier: provider,
  });

  // --- StreamableHTTP MCP transport ---
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpPostHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization — create transport and connect MCP server
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports.set(sid, transport);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };

        // Build config from the authenticated developer's JWT + options.
        // Auto-refresh the JWT if it's expired and we have a refresh token.
        let devJwt = req.auth?.token;
        if (devJwt) {
          try {
            // Check if the JWT is expired by trying a lightweight call
            const testRes = await fetch(`${options.projectUrl}/v1/projects`, {
              headers: { Authorization: `Bearer ${devJwt}` },
            });
            if (testRes.status === 401) {
              const rt = provider.getRefreshToken();
              if (rt) {
                const refreshRes = await fetch(
                  `${options.projectUrl}/v1/auth/refresh`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refresh_token: rt }),
                  },
                );
                if (refreshRes.ok) {
                  const data = (await refreshRes.json()) as { access_token: string };
                  devJwt = data.access_token;
                  // Update the session so future requests use the new token
                  provider.updateSessionToken(req.auth?.token ?? "", devJwt);
                  console.error("[pqdb-mcp] Auto-refreshed developer JWT");
                } else {
                  console.error("[pqdb-mcp] Failed to refresh JWT — re-authentication required");
                }
              }
            }
          } catch {
            // Ignore refresh errors — proceed with current token
          }
        }

        // Resolve encryption key: env var takes precedence, then OAuth-provided key
        const oauthEncryptionKey = devJwt
          ? provider.getSessionEncryptionKey(devJwt)
          : undefined;
        const resolvedEncryptionKey =
          options.encryptionKey ?? oauthEncryptionKey;

        // Resolve project ID for the developer JWT auth path.
        // The backend accepts developer JWTs on /v1/db/* endpoints via
        // Authorization: Bearer + x-project-id header — no service key needed.
        let projectId: string | undefined;
        const apiKey = options.apiKey ?? "";
        if (!apiKey && devJwt) {
          try {
            const projRes = await fetch(`${options.projectUrl}/v1/projects`, {
              headers: { Authorization: `Bearer ${devJwt}` },
            });
            if (projRes.ok) {
              const projects = (await projRes.json()) as Array<{ id: string }>;
              if (projects.length > 0) {
                projectId = projects[0].id;
                console.error(
                  `[pqdb-mcp] Using developer JWT auth for project ${projectId}`,
                );
              }
            }
          } catch {
            console.error("[pqdb-mcp] Failed to fetch project list");
          }
        }

        // Set shared auth state so all tool modules can auto-refresh
        setAuthState({
          devToken: devJwt,
          projectId,
          refreshToken: provider.getRefreshToken(),
          projectUrl: options.projectUrl,
        });

        const config: ServerConfig = {
          projectUrl: options.projectUrl,
          transport: "http",
          port: 0, // Not used for HTTP app
          apiKey,
          encryptionKey: resolvedEncryptionKey,
          devToken: devJwt,
          projectId,
          privateKey: undefined,
          mode: "full",
          target: undefined,
          recoveryFile: undefined,
        };

        const { mcpServer } = createPqdbMcpServer(config);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[pqdb-mcp] Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  };

  app.post("/mcp", authMiddleware, mcpPostHandler);
  app.get("/mcp", authMiddleware, mcpGetHandler);
  app.delete("/mcp", authMiddleware, mcpDeleteHandler);

  return app;
}
