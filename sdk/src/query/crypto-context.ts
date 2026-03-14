/**
 * CryptoContext — holds the encryption state needed by the query builder
 * to perform transparent encryption/decryption.
 */
import type { KeyPair } from "../crypto/pqc.js";

export interface CryptoContext {
  /** The derived ML-KEM-768 key pair. */
  readonly keyPair: KeyPair;
  /** Get the HMAC key (lazily fetched and cached). */
  getHmacKey(): Promise<Uint8Array>;
}
