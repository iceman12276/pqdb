/**
 * Client-side PQC decryption utility for the Dashboard.
 *
 * Uses the same ML-KEM-768 + AES-256-GCM scheme as @pqdb/client.
 * This module uses dynamic imports to avoid blocking vitest transforms.
 */

const KEM_CIPHERTEXT_BYTES = 1088;
const AES_NONCE_BYTES = 12;

/**
 * Decode a base64 string to Uint8Array.
 */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derive an ML-KEM-768 secret key from the master encryption key.
 * Deterministic — same input always produces same key pair.
 */
export async function deriveSecretKey(encryptionKey: string): Promise<Uint8Array> {
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const { sha3_256 } = await import("@noble/hashes/sha3.js");

  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(encryptionKey);
  const d = sha3_256(new Uint8Array([...keyBytes, 0x01]));
  const z = sha3_256(new Uint8Array([...keyBytes, 0x02]));
  const seed = new Uint8Array(64);
  seed.set(d, 0);
  seed.set(z, 32);
  const { secretKey } = ml_kem768.keygen(seed);
  return secretKey;
}

/**
 * Decrypt a base64-encoded ciphertext using ML-KEM-768 + AES-256-GCM.
 * Returns the plaintext string, or null on failure.
 */
export async function decryptValue(
  encryptedBase64: string,
  secretKey: Uint8Array,
): Promise<string | null> {
  try {
    const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

    const ciphertext = fromBase64(encryptedBase64);

    const kemCiphertext = ciphertext.slice(0, KEM_CIPHERTEXT_BYTES);
    const nonce = ciphertext.slice(
      KEM_CIPHERTEXT_BYTES,
      KEM_CIPHERTEXT_BYTES + AES_NONCE_BYTES,
    );
    const aesCiphertext = ciphertext.slice(
      KEM_CIPHERTEXT_BYTES + AES_NONCE_BYTES,
    );

    const sharedSecret = ml_kem768.decapsulate(kemCiphertext, secretKey);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(sharedSecret).buffer as ArrayBuffer,
      "AES-GCM",
      false,
      ["decrypt"],
    );

    const plaintextBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        aesKey,
        aesCiphertext,
      ),
    );

    return new TextDecoder().decode(plaintextBytes);
  } catch {
    return null;
  }
}
