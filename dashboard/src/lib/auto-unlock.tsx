/**
 * AutoUnlock — component that automatically unlocks the encryption context
 * using the best available project key.
 *
 * Priority:
 * 1. PQC project key from decapsulate (useProjectKeys) — base64url encoded
 * 2. Legacy envelope encryption key (useEnvelopeKeys) — used as-is
 *
 * Renders nothing — pure side-effect component.
 */

import * as React from "react";
import { useProjectKeys, useEnvelopeKeys } from "./keypair-context";
import { useEncryption } from "./encryption-context";

/**
 * Encode bytes to base64url without padding.
 * Matches the MCP server's bytesToBase64UrlNoPad — the SDK's deriveKeyPair
 * consumes this format.
 */
export function bytesToBase64UrlNoPad(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function AutoUnlock({ projectId }: { projectId: string }) {
  const { getProjectKey } = useProjectKeys();
  const { getEncryptionKey } = useEnvelopeKeys();
  const { unlock, isUnlocked } = useEncryption();

  React.useEffect(() => {
    if (isUnlocked) return;

    // Prefer PQC project key from decapsulate
    const pqcKey = getProjectKey(projectId);
    if (pqcKey) {
      unlock(bytesToBase64UrlNoPad(pqcKey));
      return;
    }

    // Fall back to legacy envelope key
    const legacyKey = getEncryptionKey(projectId);
    if (legacyKey) {
      unlock(legacyKey);
    }
  }, [projectId, getProjectKey, getEncryptionKey, unlock, isUnlocked]);

  return null;
}
