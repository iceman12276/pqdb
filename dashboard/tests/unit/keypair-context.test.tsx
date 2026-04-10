import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import * as React from "react";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// Hoisted mocks — must be declared before module imports
const { mockLoadKeypair, mockGetAccessToken } = vi.hoisted(() => ({
  mockLoadKeypair: vi.fn(),
  mockGetAccessToken: vi.fn(),
}));

vi.mock("~/lib/keypair-store", () => ({
  loadKeypair: mockLoadKeypair,
}));

vi.mock("~/lib/auth-store", () => ({
  getAccessToken: mockGetAccessToken,
  onLogout: vi.fn(() => () => {}),
}));

// Mock envelope-crypto (needed by legacy envelope key functionality)
vi.mock("~/lib/envelope-crypto", () => ({
  unwrapKey: vi.fn(),
  wrapKey: vi.fn(),
  generateEncryptionKey: vi.fn(),
}));

// Mock global fetch (used by legacy envelope key auto-unwrap)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { KeypairProvider, useKeypair } from "~/lib/keypair-context";

/**
 * Build a fake JWT access token with the given `sub` claim.
 * The signature is bogus but the payload is valid base64url JSON.
 */
function fakeAccessToken(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, exp: 9999999999 }));
  return `${header}.${payload}.fake-sig`;
}

describe("keypair-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    globalThis.indexedDB = new IDBFactory();
    sessionStorage.clear();
  });

  it("loads keypair from IndexedDB and returns {publicKey, privateKey, loaded: true}", async () => {
    const devId = "11111111-1111-1111-1111-111111111111";
    const storedKeypair = {
      publicKey: new Uint8Array([1, 2, 3, 4]),
      secretKey: new Uint8Array([5, 6, 7, 8]),
    };

    mockGetAccessToken.mockReturnValue(fakeAccessToken(devId));
    mockLoadKeypair.mockResolvedValue(storedKeypair);
    // Prevent auto-unwrap fetch from interfering
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useKeypair(), {
      wrapper: KeypairProvider,
    });

    // Initially loaded is false
    expect(result.current.loaded).toBe(false);

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.publicKey).toEqual(storedKeypair.publicKey);
    expect(result.current.privateKey).toEqual(storedKeypair.secretKey);
    expect(result.current.error).toBeNull();
  });

  it("returns {loaded: true, error: 'missing'} when IndexedDB has no keypair", async () => {
    const devId = "22222222-2222-2222-2222-222222222222";

    mockGetAccessToken.mockReturnValue(fakeAccessToken(devId));
    mockLoadKeypair.mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useKeypair(), {
      wrapper: KeypairProvider,
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.publicKey).toBeNull();
    expect(result.current.privateKey).toBeNull();
    expect(result.current.error).toBe("missing");
  });

  it("does not attempt to load when no access token is present", async () => {
    mockGetAccessToken.mockReturnValue(null);
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useKeypair(), {
      wrapper: KeypairProvider,
    });

    // Should remain in initial state — no token means no developer id
    // Give it a tick to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockLoadKeypair).not.toHaveBeenCalled();
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("handles IndexedDB errors gracefully by setting error", async () => {
    const devId = "33333333-3333-3333-3333-333333333333";

    mockGetAccessToken.mockReturnValue(fakeAccessToken(devId));
    mockLoadKeypair.mockRejectedValue(new Error("IDB quota exceeded"));
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useKeypair(), {
      wrapper: KeypairProvider,
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.publicKey).toBeNull();
    expect(result.current.privateKey).toBeNull();
    expect(result.current.error).toBe("missing");
  });
});
