import { describe, it, expect } from "vitest";
import { computeBlindIndex } from "../../src/crypto/blind-index.js";
import { generateHmacKey } from "../../src/crypto/hmac.js";

describe("computeBlindIndex", () => {
  it("returns a hex string", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("alice@example.com", key);

    expect(typeof result).toBe("string");
    // SHA3-256 produces 32 bytes = 64 hex chars
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same input + same key = same hash", () => {
    const key = generateHmacKey();
    const h1 = computeBlindIndex("alice@example.com", key);
    const h2 = computeBlindIndex("alice@example.com", key);

    expect(h1).toBe(h2);
  });

  it("different values produce different hashes", () => {
    const key = generateHmacKey();
    const h1 = computeBlindIndex("alice@example.com", key);
    const h2 = computeBlindIndex("bob@example.com", key);

    expect(h1).not.toBe(h2);
  });

  it("different keys produce different hashes for the same value", () => {
    const key1 = generateHmacKey();
    const key2 = generateHmacKey();
    const h1 = computeBlindIndex("alice@example.com", key1);
    const h2 = computeBlindIndex("alice@example.com", key2);

    expect(h1).not.toBe(h2);
  });

  it("handles empty string input", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("", key);

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles unicode input", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("こんにちは", key);

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
