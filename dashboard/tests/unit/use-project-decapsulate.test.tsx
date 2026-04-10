import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import * as React from "react";

// Hoisted mocks
const {
  mockDecapsulate,
  mockSetProjectKey,
  mockGetProjectKey,
  mockUseKeypair,
} = vi.hoisted(() => ({
  mockDecapsulate: vi.fn(),
  mockSetProjectKey: vi.fn(),
  mockGetProjectKey: vi.fn(),
  mockUseKeypair: vi.fn(),
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
}));

import { useProjectDecapsulate } from "~/lib/use-project-decapsulate";

/**
 * Encode a Uint8Array to standard base64 (matching what the backend returns
 * for wrapped_encryption_key).
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("useProjectDecapsulate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decapsulates wrapped_encryption_key, stores the shared secret via setProjectKey", async () => {
    const projectId = "proj-123";
    const privateKey = new Uint8Array([10, 20, 30]);
    const ciphertextBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const wrappedEncryptionKey = toBase64(ciphertextBytes);
    const sharedSecret = new Uint8Array(32).fill(0xab);

    mockUseKeypair.mockReturnValue({
      publicKey: new Uint8Array([99]),
      privateKey,
      loaded: true,
      error: null,
    });
    mockGetProjectKey.mockReturnValue(null);
    mockDecapsulate.mockResolvedValue(sharedSecret);

    const { result } = renderHook(() =>
      useProjectDecapsulate(projectId, wrappedEncryptionKey),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    expect(mockDecapsulate).toHaveBeenCalledWith(ciphertextBytes, privateKey);
    expect(mockSetProjectKey).toHaveBeenCalledWith(projectId, sharedSecret);
    expect(result.current.error).toBeNull();
  });

  it("returns status 'no-key' when wrapped_encryption_key is null", async () => {
    mockUseKeypair.mockReturnValue({
      publicKey: new Uint8Array([99]),
      privateKey: new Uint8Array([10]),
      loaded: true,
      error: null,
    });
    mockGetProjectKey.mockReturnValue(null);

    const { result } = renderHook(() =>
      useProjectDecapsulate("proj-456", null),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("no-key");
    });

    expect(mockDecapsulate).not.toHaveBeenCalled();
    expect(mockSetProjectKey).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("returns status 'error' with message when decapsulate throws", async () => {
    const privateKey = new Uint8Array([10, 20, 30]);
    const ciphertextBytes = new Uint8Array([1, 2, 3]);
    const wrappedKey = toBase64(ciphertextBytes);

    mockUseKeypair.mockReturnValue({
      publicKey: new Uint8Array([99]),
      privateKey,
      loaded: true,
      error: null,
    });
    mockGetProjectKey.mockReturnValue(null);
    mockDecapsulate.mockRejectedValue(new Error("Decapsulation failed"));

    const { result } = renderHook(() =>
      useProjectDecapsulate("proj-789", wrappedKey),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    expect(result.current.error).toBe(
      "Could not decrypt this project. You may need to upload a different recovery file.",
    );
  });

  it("returns status 'loading' when keypair has not loaded yet", () => {
    mockUseKeypair.mockReturnValue({
      publicKey: null,
      privateKey: null,
      loaded: false,
      error: null,
    });
    mockGetProjectKey.mockReturnValue(null);

    const { result } = renderHook(() =>
      useProjectDecapsulate("proj-wait", "AAAA"),
    );

    expect(result.current.status).toBe("loading");
  });

  it("skips decapsulation when project key is already stored", async () => {
    const existingSecret = new Uint8Array(32).fill(0xcc);

    mockUseKeypair.mockReturnValue({
      publicKey: new Uint8Array([99]),
      privateKey: new Uint8Array([10]),
      loaded: true,
      error: null,
    });
    mockGetProjectKey.mockReturnValue(existingSecret);

    const { result } = renderHook(() =>
      useProjectDecapsulate("proj-cached", "AAAA"),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    expect(mockDecapsulate).not.toHaveBeenCalled();
    expect(mockSetProjectKey).not.toHaveBeenCalled();
  });

  it("returns status 'no-keypair' when keypair is loaded but privateKey is null", () => {
    mockUseKeypair.mockReturnValue({
      publicKey: null,
      privateKey: null,
      loaded: true,
      error: "missing",
    });
    mockGetProjectKey.mockReturnValue(null);

    const { result } = renderHook(() =>
      useProjectDecapsulate("proj-nokey", "AAAA"),
    );

    expect(result.current.status).toBe("no-keypair");
  });
});
