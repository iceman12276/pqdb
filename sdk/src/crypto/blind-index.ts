/**
 * Blind index computation for searchable encrypted columns.
 *
 * Uses HMAC-SHA3-256 to produce a deterministic, non-reversible index
 * that allows equality queries without revealing plaintext.
 */
import { hmacSha3_256 } from "./hmac.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Compute a blind index for a value using HMAC-SHA3-256.
 *
 * @param value - The plaintext value to index
 * @param hmacKey - The 256-bit HMAC key (per-project, from Vault)
 * @returns Hex-encoded 32-byte hash string
 */
export function computeBlindIndex(
  value: string,
  hmacKey: Uint8Array,
): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = hmacSha3_256(hmacKey, data);
  return bytesToHex(digest);
}
