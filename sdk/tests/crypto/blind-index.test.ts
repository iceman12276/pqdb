import { describe, it, expect } from "vitest";
import { computeBlindIndex } from "../../src/crypto/blind-index.js";
import { generateHmacKey } from "../../src/crypto/hmac.js";

describe("computeBlindIndex", () => {
  it("returns a version-prefixed hex string when version is provided", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("alice@example.com", key, 1);

    expect(typeof result).toBe("string");
    // Format: v{N}:{64 hex chars}
    expect(result).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("returns raw hex string when no version is provided (backward compat)", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("alice@example.com", key);

    expect(typeof result).toBe("string");
    // SHA3-256 produces 32 bytes = 64 hex chars, no prefix
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("version prefix changes with different version numbers", () => {
    const key = generateHmacKey();
    const v1 = computeBlindIndex("alice@example.com", key, 1);
    const v2 = computeBlindIndex("alice@example.com", key, 2);

    expect(v1).toMatch(/^v1:/);
    expect(v2).toMatch(/^v2:/);
    // Same key and value → same hash, just different prefix
    expect(v1.slice(3)).toBe(v2.slice(3));
  });

  it("is deterministic: same input + same key + same version = same hash", () => {
    const key = generateHmacKey();
    const h1 = computeBlindIndex("alice@example.com", key, 1);
    const h2 = computeBlindIndex("alice@example.com", key, 1);

    expect(h1).toBe(h2);
  });

  it("different values produce different hashes", () => {
    const key = generateHmacKey();
    const h1 = computeBlindIndex("alice@example.com", key, 1);
    const h2 = computeBlindIndex("bob@example.com", key, 1);

    expect(h1).not.toBe(h2);
  });

  it("different keys produce different hashes for the same value", () => {
    const key1 = generateHmacKey();
    const key2 = generateHmacKey();
    const h1 = computeBlindIndex("alice@example.com", key1, 1);
    const h2 = computeBlindIndex("alice@example.com", key2, 1);

    expect(h1).not.toBe(h2);
  });

  it("handles empty string input", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("", key, 1);

    expect(result).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("handles unicode input", () => {
    const key = generateHmacKey();
    const result = computeBlindIndex("こんにちは", key, 1);

    expect(result).toMatch(/^v1:[0-9a-f]{64}$/);
  });
});
