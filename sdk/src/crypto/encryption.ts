/**
 * High-level encrypt/decrypt wrapper using ML-KEM-768 (hybrid KEM + AES-256-GCM).
 *
 * ML-KEM is a Key Encapsulation Mechanism — it produces a shared secret, not
 * ciphertext directly. We use the shared secret as an AES-256-GCM key to
 * encrypt the plaintext. The output is: KEM ciphertext || AES-GCM nonce || AES-GCM ciphertext.
 */
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import type { KeyPair } from "./pqc.js";

const KEM_CIPHERTEXT_BYTES = 1088;
const AES_NONCE_BYTES = 12;

/**
 * Derive a deterministic ML-KEM-768 key pair from a master encryption key string.
 *
 * Uses SHA3-256 to derive a 32-byte seed, then feeds it to ML-KEM-768 keygen_derand.
 * Two 32-byte seeds are needed for ML-KEM-768 keygen_derand (d and z).
 */
export async function deriveKeyPair(encryptionKey: string): Promise<KeyPair> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(encryptionKey);

  // Derive two 32-byte seeds: d (for key generation) and z (for implicit rejection)
  const d = sha3_256(new Uint8Array([...keyBytes, 0x01]));
  const z = sha3_256(new Uint8Array([...keyBytes, 0x02]));

  const seed = new Uint8Array(64);
  seed.set(d, 0);
  seed.set(z, 32);

  const { publicKey, secretKey } = ml_kem768.keygen(seed);
  return { publicKey, secretKey };
}

/**
 * Encrypt a plaintext string using ML-KEM-768 + AES-256-GCM.
 *
 * Returns: KEM_ciphertext (1088 bytes) || nonce (12 bytes) || AES_ciphertext (variable)
 */
export async function encrypt(
  plaintext: string,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  // Step 1: KEM encapsulate to get shared secret
  const { cipherText: kemCiphertext, sharedSecret } =
    ml_kem768.encapsulate(publicKey);

  // Step 2: Use shared secret as AES-256-GCM key
  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "AES-GCM",
    false,
    ["encrypt"],
  );

  // Step 3: Generate random nonce and encrypt
  const nonce = crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  const aesCiphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      plaintextBytes,
    ),
  );

  // Step 4: Concatenate: KEM ciphertext || nonce || AES ciphertext
  const result = new Uint8Array(
    kemCiphertext.byteLength + nonce.byteLength + aesCiphertext.byteLength,
  );
  result.set(kemCiphertext, 0);
  result.set(nonce, kemCiphertext.byteLength);
  result.set(aesCiphertext, kemCiphertext.byteLength + nonce.byteLength);

  return result;
}

/**
 * Decrypt ciphertext produced by encrypt().
 *
 * Parses: KEM_ciphertext (1088 bytes) || nonce (12 bytes) || AES_ciphertext (rest)
 */
export async function decrypt(
  ciphertext: Uint8Array,
  secretKey: Uint8Array,
): Promise<string> {
  // Step 1: Split the ciphertext
  const kemCiphertext = ciphertext.slice(0, KEM_CIPHERTEXT_BYTES);
  const nonce = ciphertext.slice(
    KEM_CIPHERTEXT_BYTES,
    KEM_CIPHERTEXT_BYTES + AES_NONCE_BYTES,
  );
  const aesCiphertext = ciphertext.slice(
    KEM_CIPHERTEXT_BYTES + AES_NONCE_BYTES,
  );

  // Step 2: KEM decapsulate to recover shared secret
  const sharedSecret = ml_kem768.decapsulate(kemCiphertext, secretKey);

  // Step 3: Use shared secret as AES-256-GCM key
  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "AES-GCM",
    false,
    ["decrypt"],
  );

  // Step 4: Decrypt
  try {
    const plaintextBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        aesKey,
        aesCiphertext,
      ),
    );
    return new TextDecoder().decode(plaintextBytes);
  } catch {
    throw new Error("Decryption failed: invalid key or corrupted ciphertext");
  }
}
