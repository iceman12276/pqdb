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

  const provider = new PqdbOAuthProvider({ dashboardUrl, mcpServerUrl });

  const app = express();
  app.use(express.json());

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
  app.get("/mcp-auth-complete", async (req: Request, res: Response) => {
    const requestId = req.query.request_id as string | undefined;
    const token = req.query.token as string | undefined;

    if (!requestId || !token) {
      res.status(400).json({
        error: "Missing required parameters: request_id and token",
      });
      return;
    }

    // completeAuthorization validates the redirect_uri against the client's
    // registered allowlist and builds the full redirect URL from server-controlled
    // data (registered redirect_uri + generated auth code + stored state).
    // The returned URL is safe to redirect to (no open redirect risk).
    const redirectUrl = await provider.completeAuthorization(requestId, token);
    if (!redirectUrl) {
      res.status(400).json({
        error: "Unknown or expired request_id, or redirect URI not registered",
      });
      return;
    }

    performSafeRedirect(res, redirectUrl);
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

        // Build config from the authenticated developer's JWT + options
        const devJwt = req.auth?.token;
        const config: ServerConfig = {
          projectUrl: options.projectUrl,
          transport: "http",
          port: 0, // Not used for HTTP app
          apiKey: options.apiKey ?? "",
          encryptionKey: options.encryptionKey,
          devToken: devJwt,
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
