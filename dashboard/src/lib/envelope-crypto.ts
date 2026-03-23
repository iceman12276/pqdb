/**
 * Envelope encryption utilities for client-side key management.
 *
 * Uses WebCrypto API exclusively — no external dependencies.
 * - PBKDF2-SHA256 derives a wrapping key from the developer's password
 * - AES-256-GCM wraps/unwraps per-project encryption keys
 * - Encryption keys are random 32-byte values encoded as base64url
 */

export const PBKDF2_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derive an AES-256-GCM wrapping key from a password and email.
 * Salt is deterministic: "pqdb-envelope-v1:{email}"
 */
export async function deriveWrappingKey(
  password: string,
  email: string,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`pqdb-envelope-v1:${email}`),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Generate a random 32-byte encryption key as a base64url string (no padding).
 */
export function generateEncryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // Convert to base64, then to base64url (no padding)
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Wrap an encryption key with AES-256-GCM.
 * Returns: [12-byte nonce | ciphertext+tag]
 */
export async function wrapKey(
  encryptionKey: string,
  wrappingKey: CryptoKey,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    wrappingKey,
    encoder.encode(encryptionKey),
  );

  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

/**
 * Unwrap an encryption key from a wrapped blob.
 * Expects: [12-byte nonce | ciphertext+tag]
 */
export async function unwrapKey(
  wrappedBlob: Uint8Array,
  wrappingKey: CryptoKey,
): Promise<string> {
  const nonce = wrappedBlob.slice(0, 12);
  const ciphertext = wrappedBlob.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    wrappingKey,
    ciphertext,
  );
  return decoder.decode(plaintext);
}
