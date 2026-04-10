import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";

// Hoisted mocks
const {
  mockDecapsulate,
  mockUseKeypair,
  mockSetProjectKey,
  mockGetProjectKey,
  mockGetEncryptionKey,
  mockUnlock,
} = vi.hoisted(() => ({
  mockDecapsulate: vi.fn(),
  mockUseKeypair: vi.fn(),
  mockSetProjectKey: vi.fn(),
  mockGetProjectKey: vi.fn(),
  mockGetEncryptionKey: vi.fn(),
  mockUnlock: vi.fn(),
}));

vi.mock("@pqdb/client", () => ({
  decapsulate: mockDecapsulate,
}));

vi.mock("~/lib/keypair-context", () => ({
  useKeypair: mockUseKeypair,
  useProjectKeys: () => ({
    setProjectKey: mockSetProjectKey,
    getProjectKey: mockGetProjectKey,
  }),
  useEnvelopeKeys: () => ({
    getEncryptionKey: mockGetEncryptionKey,
  }),
}));

vi.mock("~/lib/encryption-context", () => ({
  useEncryption: () => ({
    unlock: mockUnlock,
    isUnlocked: false,
    encryptionKey: null,
    lock: vi.fn(),
  }),
}));

import { AutoUnlock } from "~/lib/auto-unlock";

/**
 * Encode Uint8Array to base64url without padding (same as MCP pattern).
 */
function bytesToBase64UrlNoPad(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("AutoUnlock — PQC key preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseKeypair.mockReturnValue({
      publicKey: null,
      privateKey: null,
      loaded: true,
      error: null,
    });
  });

  it("uses PQC project key (base64url-encoded) when available", () => {
    const sharedSecret = new Uint8Array(32).fill(0xab);
    mockGetProjectKey.mockReturnValue(sharedSecret);
    mockGetEncryptionKey.mockReturnValue(null);

    render(<AutoUnlock projectId="proj-pqc" />);

    expect(mockUnlock).toHaveBeenCalledWith(
      bytesToBase64UrlNoPad(sharedSecret),
    );
  });

  it("falls back to legacy envelope key when PQC key is not available", () => {
    mockGetProjectKey.mockReturnValue(null);
    mockGetEncryptionKey.mockReturnValue("legacy-key-abc");

    render(<AutoUnlock projectId="proj-legacy" />);

    expect(mockUnlock).toHaveBeenCalledWith("legacy-key-abc");
  });

  it("does not call unlock when neither PQC key nor legacy key is available", () => {
    mockGetProjectKey.mockReturnValue(null);
    mockGetEncryptionKey.mockReturnValue(null);

    render(<AutoUnlock projectId="proj-none" />);

    expect(mockUnlock).not.toHaveBeenCalled();
  });

  it("prefers PQC key over legacy key when both are available", () => {
    const sharedSecret = new Uint8Array(32).fill(0xdd);
    mockGetProjectKey.mockReturnValue(sharedSecret);
    mockGetEncryptionKey.mockReturnValue("legacy-key-should-not-use");

    render(<AutoUnlock projectId="proj-both" />);

    expect(mockUnlock).toHaveBeenCalledWith(
      bytesToBase64UrlNoPad(sharedSecret),
    );
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });
});
