/**
 * Unit tests for auth-state: private key + shared secret storage (US-008).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  setCurrentPrivateKey,
  getCurrentPrivateKey,
  setCurrentSharedSecret,
  getCurrentSharedSecret,
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
