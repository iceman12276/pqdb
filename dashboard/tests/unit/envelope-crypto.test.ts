import { describe, it, expect } from "vitest";
import {
  deriveWrappingKey,
  generateEncryptionKey,
  wrapKey,
  unwrapKey,
  PBKDF2_ITERATIONS,
} from "~/lib/envelope-crypto";

describe("envelope-crypto", () => {
  it("exports PBKDF2_ITERATIONS = 600_000", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  it("generateEncryptionKey returns a base64url string ~43 chars, no + or = chars", () => {
    const key = generateEncryptionKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThanOrEqual(42);
    expect(key.length).toBeLessThanOrEqual(44);
    expect(key).not.toMatch(/[+/=]/);
  });

  it("generateEncryptionKey returns unique values", () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    expect(a).not.toBe(b);
  });

  it("round-trip: generate → wrap → unwrap → verify equality", async () => {
    const password = "test-password-123";
    const email = "user@example.com";

    const wrappingKey = await deriveWrappingKey(password, email);
    const encryptionKey = generateEncryptionKey();
    const wrapped = await wrapKey(encryptionKey, wrappingKey);
    const unwrapped = await unwrapKey(wrapped, wrappingKey);

    expect(unwrapped).toBe(encryptionKey);
  });

  it("wrong password fails unwrap", async () => {
    const email = "user@example.com";

    const correctKey = await deriveWrappingKey("correct-password", email);
    const wrongKey = await deriveWrappingKey("wrong-password", email);

    const encryptionKey = generateEncryptionKey();
    const wrapped = await wrapKey(encryptionKey, correctKey);

    await expect(unwrapKey(wrapped, wrongKey)).rejects.toThrow();
  });

  it("different emails produce different wrapping behavior", async () => {
    const password = "same-password";
    const key1 = await deriveWrappingKey(password, "alice@example.com");
    const key2 = await deriveWrappingKey(password, "bob@example.com");

    const encryptionKey = generateEncryptionKey();

    const wrapped1 = await wrapKey(encryptionKey, key1);
    const wrapped2 = await wrapKey(encryptionKey, key2);

    // Different wrapping keys should produce different ciphertext
    // (even though the nonces would differ too, the key difference
    // means unwrapping with the other key should fail)
    await expect(unwrapKey(wrapped1, key2)).rejects.toThrow();
    await expect(unwrapKey(wrapped2, key1)).rejects.toThrow();
  });

  it("wrapped blob has 12-byte nonce prefix + ciphertext", async () => {
    const wrappingKey = await deriveWrappingKey("pw", "e@e.com");
    const encryptionKey = generateEncryptionKey();
    const wrapped = await wrapKey(encryptionKey, wrappingKey);

    expect(wrapped).toBeInstanceOf(Uint8Array);
    // 12 bytes nonce + encrypted payload (plaintext + 16 byte GCM tag)
    expect(wrapped.length).toBe(12 + encryptionKey.length + 16);
  });
});
