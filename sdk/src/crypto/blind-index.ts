/**
 * Blind index computation for searchable encrypted columns.
 *
 * Uses HMAC-SHA3-256 to produce a deterministic, non-reversible index
 * that allows equality queries without revealing plaintext.
 *
 * Supports version-prefixed format: v{N}:{hmac_hex} for key rotation.
 */
import { hmacSha3_256 } from "./hmac.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * All HMAC keys for a project with version metadata.
 * Mirrors the backend VersionedHmacKeys structure.
 */
export interface VersionedHmacKeys {
  currentVersion: number;
  keys: Record<string, Uint8Array>; // version string -> key bytes
}

/**
 * Compute a blind index for a value using HMAC-SHA3-256.
 *
 * @param value - The plaintext value to index
 * @param hmacKey - The 256-bit HMAC key (per-project, from Vault)
 * @param version - Optional key version number. If provided, output is v{N}:{hex}
 * @returns Hex-encoded 32-byte hash string, optionally version-prefixed
 */
export function computeBlindIndex(
  value: string,
  hmacKey: Uint8Array,
  version?: number,
): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = hmacSha3_256(hmacKey, data);
  const hex = bytesToHex(digest);
  if (version !== undefined) {
    return `v${version}:${hex}`;
  }
  return hex;
}
