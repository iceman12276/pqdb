/**
 * ML-KEM-768 wrapper using @noble/post-quantum (FIPS 203).
 *
 * All operations are async to allow future migration to WASM-based
 * implementations without breaking the public API.
 */
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface EncapsulationResult {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
}

/** Generate an ML-KEM-768 key pair. */
export async function generateKeyPair(): Promise<KeyPair> {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { publicKey, secretKey };
}

/** Encapsulate: produce a ciphertext and shared secret from a public key. */
export async function encapsulate(
  publicKey: Uint8Array,
): Promise<EncapsulationResult> {
  const { cipherText: ciphertext, sharedSecret } =
    ml_kem768.encapsulate(publicKey);
  return { ciphertext, sharedSecret };
}

/** Decapsulate: recover the shared secret from a ciphertext and secret key. */
export async function decapsulate(
  ciphertext: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  return ml_kem768.decapsulate(ciphertext, secretKey);
}
