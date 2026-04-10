/**
 * US-001 — verify ML-KEM primitives are exported from the package root.
 *
 * Consumers (dashboard, MCP server) should be able to import generateKeyPair,
 * encapsulate, decapsulate, and the KeyPair / EncapsulationResult types
 * directly from '@pqdb/client' without reaching into internal paths.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  encapsulate,
  decapsulate,
  type KeyPair,
  type EncapsulationResult,
} from "@pqdb/client";

describe("US-001: ML-KEM primitives exported from @pqdb/client", () => {
  it("exposes generateKeyPair, encapsulate, decapsulate as functions", () => {
    expect(typeof generateKeyPair).toBe("function");
    expect(typeof encapsulate).toBe("function");
    expect(typeof decapsulate).toBe("function");
  });

  it("performs a full ML-KEM-768 round-trip with matching shared secrets", async () => {
    const keyPair: KeyPair = await generateKeyPair();
    expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keyPair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keyPair.publicKey.byteLength).toBe(1184);
    expect(keyPair.secretKey.byteLength).toBe(2400);

    const encap: EncapsulationResult = await encapsulate(keyPair.publicKey);
    expect(encap.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encap.sharedSecret).toBeInstanceOf(Uint8Array);
    expect(encap.ciphertext.byteLength).toBe(1088);
    expect(encap.sharedSecret.byteLength).toBe(32);

    const recovered = await decapsulate(encap.ciphertext, keyPair.secretKey);
    expect(recovered).toBeInstanceOf(Uint8Array);
    expect(recovered.byteLength).toBe(32);
    expect(recovered).toEqual(encap.sharedSecret);
  });

  it("produces different shared secrets across independent encapsulations", async () => {
    const { publicKey } = await generateKeyPair();
    const a = await encapsulate(publicKey);
    const b = await encapsulate(publicKey);
    expect(a.sharedSecret).not.toEqual(b.sharedSecret);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
});
