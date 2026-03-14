import { describe, it, expect } from "vitest";
import { deriveKeyPair, encrypt, decrypt } from "../../src/crypto/encryption.js";

describe("deriveKeyPair", () => {
  it("produces a deterministic key pair from the same encryption key", async () => {
    const kp1 = await deriveKeyPair("my-secret-master-key");
    const kp2 = await deriveKeyPair("my-secret-master-key");

    expect(kp1.publicKey).toEqual(kp2.publicKey);
    expect(kp1.secretKey).toEqual(kp2.secretKey);
  });

  it("produces different key pairs for different encryption keys", async () => {
    const kp1 = await deriveKeyPair("key-one");
    const kp2 = await deriveKeyPair("key-two");

    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.secretKey).not.toEqual(kp2.secretKey);
  });

  it("returns keys with correct ML-KEM-768 sizes", async () => {
    const kp = await deriveKeyPair("test-key");
    // ML-KEM-768: public key = 1184 bytes, secret key = 2400 bytes
    expect(kp.publicKey.byteLength).toBe(1184);
    expect(kp.secretKey.byteLength).toBe(2400);
  });
});

describe("encrypt / decrypt round-trip", () => {
  it("encrypts and decrypts a string value", async () => {
    const kp = await deriveKeyPair("round-trip-key");
    const plaintext = "alice@example.com";

    const ciphertext = await encrypt(plaintext, kp.publicKey);
    const decrypted = await decrypt(ciphertext, kp.secretKey);

    expect(decrypted).toBe(plaintext);
  });

  it("encrypts to different ciphertexts each time (randomized)", async () => {
    const kp = await deriveKeyPair("random-key");
    const plaintext = "same-value";

    const ct1 = await encrypt(plaintext, kp.publicKey);
    const ct2 = await encrypt(plaintext, kp.publicKey);

    expect(ct1).not.toEqual(ct2);
  });

  it("handles empty string", async () => {
    const kp = await deriveKeyPair("empty-key");
    const ciphertext = await encrypt("", kp.publicKey);
    const decrypted = await decrypt(ciphertext, kp.secretKey);
    expect(decrypted).toBe("");
  });

  it("handles unicode text", async () => {
    const kp = await deriveKeyPair("unicode-key");
    const plaintext = "こんにちは世界 🌍";
    const ciphertext = await encrypt(plaintext, kp.publicKey);
    const decrypted = await decrypt(ciphertext, kp.secretKey);
    expect(decrypted).toBe(plaintext);
  });

  it("handles long strings", async () => {
    const kp = await deriveKeyPair("long-key");
    const plaintext = "x".repeat(10000);
    const ciphertext = await encrypt(plaintext, kp.publicKey);
    const decrypted = await decrypt(ciphertext, kp.secretKey);
    expect(decrypted).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", async () => {
    const kp1 = await deriveKeyPair("correct-key");
    const kp2 = await deriveKeyPair("wrong-key");

    const ciphertext = await encrypt("secret", kp1.publicKey);

    await expect(decrypt(ciphertext, kp2.secretKey)).rejects.toThrow();
  });
});
