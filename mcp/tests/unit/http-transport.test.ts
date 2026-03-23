/**
 * Tests for the HTTP transport + OAuth integration in cli.ts.
 *
 * Tests the Express app setup: auth routes, /mcp endpoint, /mcp-auth-complete callback.
 * Uses supertest to exercise the real Express app without starting a server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createMcpHttpApp } from "../../src/http-app.js";
import type { Express } from "express";

describe("MCP HTTP App", () => {
  let app: Express;

  beforeAll(() => {
    app = createMcpHttpApp({
      dashboardUrl: "http://localhost:3000",
      mcpServerUrl: "http://localhost:3002",
      projectUrl: "http://localhost:8000",
    });
  });

  describe("OAuth metadata", () => {
    it("serves authorization server metadata at /.well-known/oauth-authorization-server", async () => {
      const res = await request(app).get("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      expect(res.body.issuer).toBeDefined();
      expect(res.body.authorization_endpoint).toBeDefined();
      expect(res.body.token_endpoint).toBeDefined();
    });
  });

  describe("Dynamic client registration", () => {
    it("registers a client at /register", async () => {
      const res = await request(app)
        .post("/register")
        .send({
          redirect_uris: ["http://127.0.0.1:9999/callback"],
          client_name: "Claude Code",
        });
      expect(res.status).toBe(201);
      expect(res.body.client_id).toBeDefined();
    });
  });

  describe("/authorize", () => {
    it("redirects to dashboard login", async () => {
      // First register a client
      const regRes = await request(app)
        .post("/register")
        .send({
          redirect_uris: ["http://127.0.0.1:9999/callback"],
        });
      const clientId = regRes.body.client_id;

      const res = await request(app).get("/authorize").query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/callback",
        code_challenge: "test-challenge",
        code_challenge_method: "S256",
        state: "test-state",
      });

      // Should redirect (302) to the dashboard login
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("localhost:3000/login");
      expect(res.headers.location).toContain("mcp_callback");
      expect(res.headers.location).toContain("request_id");
    });
  });

  describe("/mcp-auth-complete", () => {
    it("returns 400 when request_id is missing", async () => {
      const res = await request(app)
        .get("/mcp-auth-complete")
        .query({ token: "some-jwt" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when token is missing", async () => {
      const res = await request(app)
        .get("/mcp-auth-complete")
        .query({ request_id: "some-id" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for unknown request_id", async () => {
      const res = await request(app)
        .get("/mcp-auth-complete")
        .query({ request_id: "unknown-id", token: "jwt" });
      expect(res.status).toBe(400);
    });

    it("redirects to Claude Code callback with auth code after valid flow", async () => {
      // 1. Register client
      const regRes = await request(app)
        .post("/register")
        .send({
          redirect_uris: ["http://127.0.0.1:9999/callback"],
        });
      const clientId = regRes.body.client_id;

      // 2. Start authorize flow
      const authRes = await request(app).get("/authorize").query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/callback",
        code_challenge: "test-challenge",
        code_challenge_method: "S256",
        state: "test-state",
      });

      // Extract request_id from the dashboard redirect URL
      const dashboardUrl = new URL(authRes.headers.location);
      const requestId = dashboardUrl.searchParams.get("request_id")!;
      expect(requestId).toBeTruthy();

      // 3. Simulate dashboard callback
      const callbackRes = await request(app)
        .get("/mcp-auth-complete")
        .query({ request_id: requestId, token: "developer-jwt-123" });

      // Should redirect back to Claude Code's redirect_uri with code and state
      expect(callbackRes.status).toBe(302);
      const redirectUrl = new URL(callbackRes.headers.location);
      expect(redirectUrl.origin).toBe("http://127.0.0.1:9999");
      expect(redirectUrl.pathname).toBe("/callback");
      expect(redirectUrl.searchParams.get("code")).toBeTruthy();
      expect(redirectUrl.searchParams.get("state")).toBe("test-state");
    });

    it("accepts encryption_key in callback and passes it through to session", async () => {
      // 1. Register client
      const regRes = await request(app)
        .post("/register")
        .send({
          redirect_uris: ["http://127.0.0.1:9999/callback"],
        });
      const clientId = regRes.body.client_id;

      // 2. Start authorize flow
      const authRes = await request(app).get("/authorize").query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/callback",
        code_challenge: "test-challenge",
        code_challenge_method: "S256",
        state: "test-state",
      });

      const dashboardUrl = new URL(authRes.headers.location);
      const requestId = dashboardUrl.searchParams.get("request_id")!;

      // 3. Simulate dashboard callback WITH encryption_key
      const callbackRes = await request(app)
        .get("/mcp-auth-complete")
        .query({
          request_id: requestId,
          token: "developer-jwt-456",
          encryption_key: "test-encryption-key-base64url",
        });

      expect(callbackRes.status).toBe(302);
    });
  });

  describe("/mcp POST (unauthenticated)", () => {
    it("returns 401 when no Bearer token is provided", async () => {
      const res = await request(app)
        .post("/mcp")
        .send({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
          id: 1,
        });
      expect(res.status).toBe(401);
    });
  });
});
