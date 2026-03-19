import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the base64url helpers by importing from the module
// The actual WebAuthn calls require browser APIs, so we test
// the fetch/response handling with mocked fetch

describe("passkey module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("startPasskeyAuthentication throws on challenge fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ detail: "Server error" }),
      }),
    );

    const { startPasskeyAuthentication } = await import("~/lib/passkey");
    await expect(startPasskeyAuthentication()).rejects.toThrow(
      "Failed to get authentication challenge",
    );
  });

  it("startPasskeyAuthentication throws when credentials.get returns null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          challenge: "dGVzdC1jaGFsbGVuZ2U",
          rpId: "localhost",
          timeout: 60000,
          userVerification: "preferred",
          allowCredentials: [],
        }),
      }),
    );

    // Mock navigator.credentials.get to return null (user cancelled)
    Object.defineProperty(global, "navigator", {
      value: {
        credentials: {
          get: vi.fn().mockResolvedValueOnce(null),
        },
      },
      writable: true,
      configurable: true,
    });

    const { startPasskeyAuthentication } = await import("~/lib/passkey");
    await expect(startPasskeyAuthentication()).rejects.toThrow(
      "Passkey authentication was cancelled",
    );
  });
});
