import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, act, renderHook } from "@testing-library/react";
import * as React from "react";
import {
  EnvelopeKeyProvider,
  useEnvelopeKeys,
} from "~/lib/envelope-key-context";
import * as envelopeCrypto from "~/lib/envelope-crypto";

// Mock envelope-crypto module
vi.mock("~/lib/envelope-crypto", () => ({
  unwrapKey: vi.fn(),
  wrapKey: vi.fn(),
  generateEncryptionKey: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function base64Encode(str: string): string {
  return btoa(str);
}

describe("EnvelopeKeyContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
  });

  it("provides default state with null wrapping key and empty encryption keys", () => {
    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    expect(result.current.wrappingKey).toBeNull();
    expect(result.current.encryptionKeys.size).toBe(0);
  });

  it("setWrappingKey stores the wrapping key", async () => {
    const fakeKey = {} as CryptoKey;

    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.setWrappingKey(fakeKey);
    });

    expect(result.current.wrappingKey).toBe(fakeKey);
  });

  it("clearKeys resets wrapping key and encryption keys", async () => {
    const fakeKey = {} as CryptoKey;

    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.setWrappingKey(fakeKey);
      result.current.addEncryptionKey("proj-1", "key-1");
    });

    expect(result.current.wrappingKey).toBe(fakeKey);
    expect(result.current.encryptionKeys.size).toBe(1);

    await act(async () => {
      result.current.clearKeys();
    });

    expect(result.current.wrappingKey).toBeNull();
    expect(result.current.encryptionKeys.size).toBe(0);
  });

  it("getEncryptionKey returns null for unknown project", () => {
    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    expect(result.current.getEncryptionKey("unknown")).toBeNull();
  });

  it("addEncryptionKey stores and retrieves a key for a project", async () => {
    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.addEncryptionKey("proj-1", "enc-key-123");
    });

    expect(result.current.getEncryptionKey("proj-1")).toBe("enc-key-123");
  });

  it("unwrapProjectKeys decodes base64 and calls unwrapKey for each project", async () => {
    const fakeWrappingKey = {} as CryptoKey;
    (envelopeCrypto.unwrapKey as Mock).mockResolvedValue("decrypted-key-1");

    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.setWrappingKey(fakeWrappingKey);
    });

    const projects = [
      { id: "proj-1", wrapped_encryption_key: base64Encode("wrapped-blob-1") },
    ];

    await act(async () => {
      await result.current.unwrapProjectKeys(projects);
    });

    expect(envelopeCrypto.unwrapKey).toHaveBeenCalledTimes(1);
    expect(result.current.getEncryptionKey("proj-1")).toBe("decrypted-key-1");
  });

  it("unwrapProjectKeys skips projects already in the map", async () => {
    const fakeWrappingKey = {} as CryptoKey;
    (envelopeCrypto.unwrapKey as Mock).mockResolvedValue("decrypted-key-2");

    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.setWrappingKey(fakeWrappingKey);
      result.current.addEncryptionKey("proj-1", "already-known-key");
    });

    const projects = [
      { id: "proj-1", wrapped_encryption_key: base64Encode("wrapped-blob") },
      { id: "proj-2", wrapped_encryption_key: base64Encode("wrapped-blob-2") },
    ];

    await act(async () => {
      await result.current.unwrapProjectKeys(projects);
    });

    // Should only unwrap proj-2, not proj-1
    expect(envelopeCrypto.unwrapKey).toHaveBeenCalledTimes(1);
    expect(result.current.getEncryptionKey("proj-1")).toBe("already-known-key");
    expect(result.current.getEncryptionKey("proj-2")).toBe("decrypted-key-2");
  });

  it("unwrapProjectKeys auto-generates key for projects without wrapped_encryption_key", async () => {
    const fakeWrappingKey = {} as CryptoKey;
    (envelopeCrypto.generateEncryptionKey as Mock).mockReturnValue(
      "generated-key",
    );
    (envelopeCrypto.wrapKey as Mock).mockResolvedValue(
      new Uint8Array([1, 2, 3]),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.setWrappingKey(fakeWrappingKey);
    });

    const projects = [{ id: "proj-no-key", wrapped_encryption_key: null }];

    await act(async () => {
      await result.current.unwrapProjectKeys(projects);
    });

    expect(envelopeCrypto.generateEncryptionKey).toHaveBeenCalledTimes(1);
    expect(envelopeCrypto.wrapKey).toHaveBeenCalledWith(
      "generated-key",
      fakeWrappingKey,
    );
    expect(result.current.getEncryptionKey("proj-no-key")).toBe(
      "generated-key",
    );
    // Should have PATCHed the wrapped key to server
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/projects/proj-no-key/encryption-key"),
      expect.objectContaining({
        method: "PATCH",
      }),
    );
  });

  it("unwrapProjectKeys continues on error for individual project", async () => {
    const fakeWrappingKey = {} as CryptoKey;
    (envelopeCrypto.unwrapKey as Mock)
      .mockRejectedValueOnce(new Error("corrupted blob"))
      .mockResolvedValueOnce("decrypted-key-2");

    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    await act(async () => {
      result.current.setWrappingKey(fakeWrappingKey);
    });

    const projects = [
      { id: "proj-bad", wrapped_encryption_key: base64Encode("bad-blob") },
      { id: "proj-good", wrapped_encryption_key: base64Encode("good-blob") },
    ];

    await act(async () => {
      await result.current.unwrapProjectKeys(projects);
    });

    // The failed project should not be in the map
    expect(result.current.getEncryptionKey("proj-bad")).toBeNull();
    // The successful project should be in the map
    expect(result.current.getEncryptionKey("proj-good")).toBe("decrypted-key-2");
  });

  it("unwrapProjectKeys does nothing without a wrapping key", async () => {
    const { result } = renderHook(() => useEnvelopeKeys(), {
      wrapper: EnvelopeKeyProvider,
    });

    const projects = [
      { id: "proj-1", wrapped_encryption_key: base64Encode("blob") },
    ];

    await act(async () => {
      await result.current.unwrapProjectKeys(projects);
    });

    expect(envelopeCrypto.unwrapKey).not.toHaveBeenCalled();
    expect(result.current.encryptionKeys.size).toBe(0);
  });
});
