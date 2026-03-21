import { describe, it, expect, beforeEach, vi } from "vitest";
import { PqdbOAuthProvider, PqdbClientsStore } from "../../src/oauth-provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";

function makeClient(overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
  return {
    client_id: "test-client-id",
    redirect_uris: ["http://127.0.0.1:9999/callback"],
    ...overrides,
  } as OAuthClientInformationFull;
}

describe("PqdbClientsStore", () => {
  let store: PqdbClientsStore;

  beforeEach(() => {
    store = new PqdbClientsStore();
  });

  it("returns undefined for unknown client", async () => {
    expect(await store.getClient("nonexistent")).toBeUndefined();
  });

  it("registers and retrieves a client", async () => {
    const client = makeClient();
    const registered = await store.registerClient(client);
    expect(registered.client_id).toBe("test-client-id");

    const retrieved = await store.getClient("test-client-id");
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_id).toBe("test-client-id");
  });
});

describe("PqdbOAuthProvider", () => {
  let provider: PqdbOAuthProvider;
  const dashboardUrl = "http://localhost:3000";
  const mcpServerUrl = "http://localhost:3002";

  beforeEach(async () => {
    provider = new PqdbOAuthProvider({ dashboardUrl, mcpServerUrl });
    // Register the test client so redirect_uri validation passes in completeAuthorization
    await provider.clientsStore.registerClient(makeClient());
  });

  /** Helper: run authorize and extract request_id from the redirect URL. */
  async function startAuthorize(
    clientOverrides: Partial<OAuthClientInformationFull> = {},
    paramsOverrides: Record<string, string> = {},
  ) {
    const client = makeClient(clientOverrides);
    const params = {
      codeChallenge: "test-challenge",
      redirectUri: "http://127.0.0.1:9999/callback",
      state: "test-state",
      ...paramsOverrides,
    };

    const res = { redirect: vi.fn() } as unknown as Response;
    await provider.authorize(client, params, res);

    const redirectCall = (res.redirect as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const url = new URL(redirectCall);
    const requestId = url.searchParams.get("request_id")!;
    return { res, requestId, url };
  }

  describe("authorize", () => {
    it("redirects to dashboard login with mcp_callback and request_id", async () => {
      const { url } = await startAuthorize();
      expect(url.origin).toBe(dashboardUrl);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("mcp_callback")).toContain(mcpServerUrl);
      expect(url.searchParams.get("mcp_callback")).toContain("/mcp-auth-complete");
      expect(url.searchParams.has("request_id")).toBe(true);
    });

    it("stores pending auth for later completion", async () => {
      const { requestId } = await startAuthorize();
      expect(requestId).toBeTruthy();

      const pending = provider.getPendingAuth(requestId);
      expect(pending).toBeDefined();
      expect(pending!.codeChallenge).toBe("test-challenge");
      expect(pending!.redirectUri).toBe("http://127.0.0.1:9999/callback");
      expect(pending!.state).toBe("test-state");
      expect(pending!.clientId).toBe("test-client-id");
    });
  });

  describe("completeAuthorization", () => {
    it("returns a redirect URL with auth code and state", async () => {
      const { requestId } = await startAuthorize();

      const redirectUrl = await provider.completeAuthorization(requestId, "dev-jwt-token-123");
      expect(redirectUrl).toBeDefined();

      const url = new URL(redirectUrl!);
      expect(url.origin).toBe("http://127.0.0.1:9999");
      expect(url.pathname).toBe("/callback");
      expect(url.searchParams.get("code")).toBeTruthy();
      expect(url.searchParams.get("state")).toBe("test-state");
    });

    it("returns undefined for unknown request_id", async () => {
      const result = await provider.completeAuthorization("bogus", "token");
      expect(result).toBeUndefined();
    });

    it("removes pending auth after completion", async () => {
      const { requestId } = await startAuthorize();

      await provider.completeAuthorization(requestId, "dev-jwt-token");
      // Second call should return undefined — already consumed
      const second = await provider.completeAuthorization(requestId, "dev-jwt-token");
      expect(second).toBeUndefined();
    });

    it("returns undefined when redirect_uri is not in client's allowlist", async () => {
      // Register a client with a different redirect_uri
      const client = makeClient({
        client_id: "restricted-client",
        redirect_uris: ["http://127.0.0.1:7777/other"],
      });
      await provider.clientsStore.registerClient(client);

      // Authorize with a redirect_uri that differs from what's registered
      const params = {
        codeChallenge: "challenge",
        redirectUri: "http://evil.com/steal",
        state: "s",
      };
      const res = { redirect: vi.fn() } as unknown as Response;
      await provider.authorize(client, params, res);
      const url = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      const requestId = url.searchParams.get("request_id")!;

      const result = await provider.completeAuthorization(requestId, "jwt");
      expect(result).toBeUndefined();
    });
  });

  describe("challengeForAuthorizationCode", () => {
    it("returns the code challenge for a valid auth code", async () => {
      const { requestId } = await startAuthorize({}, { codeChallenge: "my-code-challenge" });

      const redirectUrl = await provider.completeAuthorization(requestId, "jwt");
      const code = new URL(redirectUrl!).searchParams.get("code")!;

      const challenge = await provider.challengeForAuthorizationCode(makeClient(), code);
      expect(challenge).toBe("my-code-challenge");
    });

    it("throws for invalid auth code", async () => {
      await expect(
        provider.challengeForAuthorizationCode(makeClient(), "invalid-code"),
      ).rejects.toThrow("Invalid authorization code");
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("returns tokens with the dev JWT as access_token", async () => {
      const { requestId } = await startAuthorize();

      const redirectUrl = await provider.completeAuthorization(requestId, "dev-jwt-token-abc");
      const code = new URL(redirectUrl!).searchParams.get("code")!;

      const tokens = await provider.exchangeAuthorizationCode(makeClient(), code);
      expect(tokens.access_token).toBe("dev-jwt-token-abc");
      expect(tokens.token_type).toBe("bearer");
    });

    it("throws for invalid auth code", async () => {
      await expect(
        provider.exchangeAuthorizationCode(makeClient(), "bad-code"),
      ).rejects.toThrow("Invalid authorization code");
    });

    it("throws when client_id does not match", async () => {
      const { requestId } = await startAuthorize();

      const redirectUrl = await provider.completeAuthorization(requestId, "jwt");
      const code = new URL(redirectUrl!).searchParams.get("code")!;

      const otherClient = makeClient({ client_id: "other-client" });
      await expect(
        provider.exchangeAuthorizationCode(otherClient, code),
      ).rejects.toThrow("not issued to this client");
    });

    it("consumes auth code — second exchange fails", async () => {
      const { requestId } = await startAuthorize();

      const redirectUrl = await provider.completeAuthorization(requestId, "jwt");
      const code = new URL(redirectUrl!).searchParams.get("code")!;

      await provider.exchangeAuthorizationCode(makeClient(), code);
      await expect(
        provider.exchangeAuthorizationCode(makeClient(), code),
      ).rejects.toThrow("Invalid authorization code");
    });
  });

  describe("verifyAccessToken", () => {
    it("returns AuthInfo for a valid token after exchange", async () => {
      const { requestId } = await startAuthorize();

      const redirectUrl = await provider.completeAuthorization(requestId, "dev-jwt-xyz");
      const code = new URL(redirectUrl!).searchParams.get("code")!;

      await provider.exchangeAuthorizationCode(makeClient(), code);

      const authInfo = await provider.verifyAccessToken("dev-jwt-xyz");
      expect(authInfo.token).toBe("dev-jwt-xyz");
      expect(authInfo.clientId).toBe("test-client-id");
      expect(authInfo.scopes).toEqual([]);
    });

    it("throws for unknown token", async () => {
      await expect(provider.verifyAccessToken("unknown-token")).rejects.toThrow(
        "Invalid or expired token",
      );
    });
  });

  describe("exchangeRefreshToken", () => {
    it("throws not implemented", async () => {
      await expect(
        provider.exchangeRefreshToken(makeClient(), "refresh-token"),
      ).rejects.toThrow();
    });
  });
});
