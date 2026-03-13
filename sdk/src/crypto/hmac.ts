/**
 * HMAC-SHA3-256 wrapper using @noble/hashes.
 *
 * Used to produce blind indexes for searchable encrypted columns.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";

/** Generate a 256-bit (32-byte) random HMAC key. */
export function generateHmacKey(): Uint8Array {
  return randomBytes(32);
}

/** Compute HMAC-SHA3-256(key, data). Returns a 32-byte digest. */
export function hmacSha3_256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha3_256, key, data);
}
