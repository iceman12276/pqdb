/**
 * Unit tests for auth-state: private key + shared secret storage (US-008).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  setCurrentPrivateKey,
  getCurrentPrivateKey,
  setCurrentSharedSecret,
  getCurrentSharedSecret,
  getCurrentEncryptionKeyString,
  clearCurrentPrivateKey,
  clearCurrentSharedSecret,
} from "../../src/auth-state.js";

describe("auth-state: private key storage (US-008)", () => {
  beforeEach(() => {
    clearCurrentPrivateKey();
    clearCurrentSharedSecret();
  });

  it("setCurrentPrivateKey then getCurrentPrivateKey round-trips the key bytes", () => {
    const key = new Uint8Array(2400);
    for (let i = 0; i < key.length; i++) {
      key[i] = i % 256;
    }
    setCurrentPrivateKey(key);
    const got = getCurrentPrivateKey();
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got!.length).toBe(2400);
    expect(got![0]).toBe(0);
    expect(got![255]).toBe(255);
  });

  it("getCurrentPrivateKey returns undefined before set", () => {
    expect(getCurrentPrivateKey()).toBeUndefined();
  });

  it("clearCurrentPrivateKey removes the stored key", () => {
    setCurrentPrivateKey(new Uint8Array(2400));
    expect(getCurrentPrivateKey()).toBeDefined();
    clearCurrentPrivateKey();
    expect(getCurrentPrivateKey()).toBeUndefined();
  });

  it("setCurrentSharedSecret then getCurrentSharedSecret round-trips", () => {
    const ss = new Uint8Array(32);
    for (let i = 0; i < 32; i++) ss[i] = i;
    setCurrentSharedSecret(ss);
    const got = getCurrentSharedSecret();
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got!.length).toBe(32);
    expect(got![0]).toBe(0);
    expect(got![31]).toBe(31);
  });

  it("getCurrentEncryptionKeyString returns null when no shared secret is set", () => {
    expect(getCurrentEncryptionKeyString()).toBeNull();
  });

  it("getCurrentEncryptionKeyString encodes the shared secret as base64url-no-padding (43 chars for 32 bytes)", () => {
    // Use a known 32-byte value so we can verify the exact encoding.
    // 32 bytes of 0xFF -> base64 "//////////////////////////////////////////8="
    //                  -> base64url-no-pad "__________________________________________8"
    const ss = new Uint8Array(32).fill(0xff);
    setCurrentSharedSecret(ss);
    const str = getCurrentEncryptionKeyString();
    expect(str).not.toBeNull();
    // 32 bytes base64url-no-pad is exactly 43 characters
    expect(str!.length).toBe(43);
    // Must not contain standard-base64 chars (+, /, =)
    expect(str).not.toMatch(/[+/=]/);
    // Round-trip: decode it back (normalize + repad) and compare
    const padded = str! + "=".repeat((4 - (str!.length % 4)) % 4);
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = new Uint8Array(Buffer.from(b64, "base64"));
    expect(decoded.length).toBe(32);
    expect(Array.from(decoded)).toEqual(Array.from(ss));
  });

  it("getCurrentEncryptionKeyString reflects updates to the stored shared secret", () => {
    setCurrentSharedSecret(new Uint8Array(32).fill(0xaa));
    const first = getCurrentEncryptionKeyString();
    setCurrentSharedSecret(new Uint8Array(32).fill(0xbb));
    const second = getCurrentEncryptionKeyString();
    expect(first).not.toBe(second);
    clearCurrentSharedSecret();
    expect(getCurrentEncryptionKeyString()).toBeNull();
  });

  it("private key and shared secret are stored independently", () => {
    const pk = new Uint8Array(2400).fill(0xaa);
    const ss = new Uint8Array(32).fill(0xbb);
    setCurrentPrivateKey(pk);
    setCurrentSharedSecret(ss);
    expect(getCurrentPrivateKey()![0]).toBe(0xaa);
    expect(getCurrentSharedSecret()![0]).toBe(0xbb);
    clearCurrentSharedSecret();
    expect(getCurrentSharedSecret()).toBeUndefined();
    // Private key survives shared-secret clear
    expect(getCurrentPrivateKey()).toBeDefined();
  });
});
