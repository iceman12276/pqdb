import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  encapsulate,
  decapsulate,
} from "../../src/crypto/pqc.js";

describe("ML-KEM-768 round-trip", () => {
  it("keygen produces valid key pair with correct sizes", async () => {
    const { publicKey, secretKey } = await generateKeyPair();

    expect(publicKey).toBeInstanceOf(Uint8Array);
    expect(secretKey).toBeInstanceOf(Uint8Array);
    // ML-KEM-768 public key = 1184 bytes, secret key = 2400 bytes
    expect(publicKey.byteLength).toBe(1184);
    expect(secretKey.byteLength).toBe(2400);
  });

  it("encapsulate returns ciphertext and shared secret", async () => {
    const { publicKey } = await generateKeyPair();
    const { ciphertext, sharedSecret } = await encapsulate(publicKey);

    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(sharedSecret).toBeInstanceOf(Uint8Array);
    // ML-KEM-768 ciphertext = 1088 bytes, shared secret = 32 bytes
    expect(ciphertext.byteLength).toBe(1088);
    expect(sharedSecret.byteLength).toBe(32);
  });

  it("decapsulate recovers the same shared secret", async () => {
    const { publicKey, secretKey } = await generateKeyPair();
    const { ciphertext, sharedSecret: senderSecret } =
      await encapsulate(publicKey);
    const receiverSecret = await decapsulate(ciphertext, secretKey);

    expect(receiverSecret).toBeInstanceOf(Uint8Array);
    expect(receiverSecret.byteLength).toBe(32);
    expect(receiverSecret).toEqual(senderSecret);
  });

  it("different encapsulations produce different shared secrets", async () => {
    const { publicKey } = await generateKeyPair();
    const result1 = await encapsulate(publicKey);
    const result2 = await encapsulate(publicKey);

    // Ciphertexts should differ (randomized encapsulation)
    expect(result1.ciphertext).not.toEqual(result2.ciphertext);
    // Shared secrets should differ
    expect(result1.sharedSecret).not.toEqual(result2.sharedSecret);
  });

  it("decapsulate with wrong secret key produces different shared secret", async () => {
    const keyPair1 = await generateKeyPair();
    const keyPair2 = await generateKeyPair();

    const { ciphertext, sharedSecret } = await encapsulate(keyPair1.publicKey);
    const wrongSecret = await decapsulate(ciphertext, keyPair2.secretKey);

    // ML-KEM implicit rejection: returns a pseudorandom value, not an error
    expect(wrongSecret).not.toEqual(sharedSecret);
  });
});
