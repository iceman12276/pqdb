import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import * as React from "react";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// Hoisted mocks — must be declared before module imports
const { mockLoadKeypair, mockGetAccessToken, loginCallbacks, logoutCallbacks } =
  vi.hoisted(() => ({
    mockLoadKeypair: vi.fn(),
    mockGetAccessToken: vi.fn(),
    loginCallbacks: new Set<() => void>(),
    logoutCallbacks: new Set<() => void>(),
  }));

vi.mock("~/lib/keypair-store", () => ({
  loadKeypair: mockLoadKeypair,
}));

vi.mock("~/lib/auth-store", () => ({
  getAccessToken: mockGetAccessToken,
  onLogin: vi.fn((cb: () => void) => {
    loginCallbacks.add(cb);
    return () => {
      loginCallbacks.delete(cb);
    };
  }),
  onLogout: vi.fn((cb: () => void) => {
    logoutCallbacks.add(cb);
    return () => {
      logoutCallbacks.delete(cb);
    };
  }),
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
    loginCallbacks.clear();
    logoutCallbacks.clear();
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

  it("loads keypair when token becomes available after initial mount (race condition fix)", async () => {
    const devId = "44444444-4444-4444-4444-444444444444";
    const storedKeypair = {
      publicKey: new Uint8Array([10, 20, 30]),
      secretKey: new Uint8Array([40, 50, 60]),
    };

    // Start with no token — simulates provider mounting before login
    mockGetAccessToken.mockReturnValue(null);
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useKeypair(), {
      wrapper: KeypairProvider,
    });

    // Initially: loaded=false, no keypair
    expect(result.current.loaded).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(mockLoadKeypair).not.toHaveBeenCalled();

    // Simulate login: token becomes available, then fire onLogin callbacks
    mockGetAccessToken.mockReturnValue(fakeAccessToken(devId));
    mockLoadKeypair.mockResolvedValue(storedKeypair);

    act(() => {
      for (const cb of loginCallbacks) cb();
    });

    // Wait for effect to re-run and load the keypair
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.publicKey).toEqual(storedKeypair.publicKey);
    expect(result.current.privateKey).toEqual(storedKeypair.secretKey);
    expect(result.current.error).toBeNull();
  });

  it("resets keypair state on logout and reloads on re-login", async () => {
    const devId = "55555555-5555-5555-5555-555555555555";
    const storedKeypair = {
      publicKey: new Uint8Array([1, 2, 3]),
      secretKey: new Uint8Array([4, 5, 6]),
    };

    // Start logged in
    mockGetAccessToken.mockReturnValue(fakeAccessToken(devId));
    mockLoadKeypair.mockResolvedValue(storedKeypair);
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useKeypair(), {
      wrapper: KeypairProvider,
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current.publicKey).toEqual(storedKeypair.publicKey);

    // Simulate logout
    mockGetAccessToken.mockReturnValue(null);
    act(() => {
      for (const cb of logoutCallbacks) cb();
    });

    expect(result.current.loaded).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(result.current.privateKey).toBeNull();

    // Simulate re-login
    const devId2 = "66666666-6666-6666-6666-666666666666";
    const keypair2 = {
      publicKey: new Uint8Array([7, 8, 9]),
      secretKey: new Uint8Array([10, 11, 12]),
    };
    mockGetAccessToken.mockReturnValue(fakeAccessToken(devId2));
    mockLoadKeypair.mockResolvedValue(keypair2);

    act(() => {
      for (const cb of loginCallbacks) cb();
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current.publicKey).toEqual(keypair2.publicKey);
    expect(result.current.privateKey).toEqual(keypair2.secretKey);
  });
});
