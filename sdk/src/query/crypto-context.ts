/**
 * CryptoContext — holds the encryption state needed by the query builder
 * to perform transparent encryption/decryption.
 */
import type { KeyPair } from "../crypto/pqc.js";
import type { VersionedHmacKeys } from "../crypto/blind-index.js";

export interface CryptoContext {
  /** The derived ML-KEM-768 key pair. */
  readonly keyPair: KeyPair;
  /** Get the current HMAC key (lazily fetched and cached). For backward compat. */
  getHmacKey(): Promise<Uint8Array>;
  /** Get all versioned HMAC keys (lazily fetched and cached). */
  getVersionedHmacKeys(): Promise<VersionedHmacKeys>;
}
