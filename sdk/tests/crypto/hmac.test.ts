import { describe, it, expect } from "vitest";
import { hmacSha3_256, generateHmacKey } from "../../src/crypto/hmac.js";

describe("HMAC-SHA3-256", () => {
  it("generateHmacKey returns a 32-byte key", () => {
    const key = generateHmacKey();

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
  });

  it("produces a 32-byte MAC", () => {
    const key = generateHmacKey();
    const data = new TextEncoder().encode("hello world");
    const mac = hmacSha3_256(key, data);

    expect(mac).toBeInstanceOf(Uint8Array);
    expect(mac.byteLength).toBe(32);
  });

  it("same input produces same output (deterministic)", () => {
    const key = generateHmacKey();
    const data = new TextEncoder().encode("test data");
    const mac1 = hmacSha3_256(key, data);
    const mac2 = hmacSha3_256(key, data);

    expect(mac1).toEqual(mac2);
  });

  it("different keys produce different MACs", () => {
    const key1 = generateHmacKey();
    const key2 = generateHmacKey();
    const data = new TextEncoder().encode("same data");

    const mac1 = hmacSha3_256(key1, data);
    const mac2 = hmacSha3_256(key2, data);

    expect(mac1).not.toEqual(mac2);
  });

  it("different data produces different MACs", () => {
    const key = generateHmacKey();
    const data1 = new TextEncoder().encode("data one");
    const data2 = new TextEncoder().encode("data two");

    const mac1 = hmacSha3_256(key, data1);
    const mac2 = hmacSha3_256(key, data2);

    expect(mac1).not.toEqual(mac2);
  });
});
