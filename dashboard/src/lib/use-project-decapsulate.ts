/**
 * useProjectDecapsulate — React hook that decapsulates a project's
 * wrapped_encryption_key using the developer's ML-KEM-768 private key.
 *
 * On success, stores the recovered shared secret via useProjectKeys().
 * Returns a status string for the UI to render appropriate banners.
 */

import * as React from "react";
import { decapsulate } from "@pqdb/client";
import { useKeypair, useProjectKeys } from "./keypair-context";

export type DecapsulateStatus =
  | "loading"
  | "no-keypair"
  | "no-key"
  | "ready"
  | "error";

export interface DecapsulateResult {
  status: DecapsulateStatus;
  error: string | null;
}

/**
 * Decode a standard base64 string to Uint8Array.
 */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function useProjectDecapsulate(
  projectId: string,
  wrappedEncryptionKey: string | null,
): DecapsulateResult {
  const { privateKey, loaded } = useKeypair();
  const { getProjectKey, setProjectKey } = useProjectKeys();
  const [status, setStatus] = React.useState<DecapsulateStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!loaded) {
      setStatus("loading");
      return;
    }

    if (!privateKey) {
      setStatus("no-keypair");
      return;
    }

    // Already have the key for this project — skip decapsulation
    const existingKey = getProjectKey(projectId);
    if (existingKey) {
      setStatus("ready");
      return;
    }

    if (wrappedEncryptionKey === null) {
      setStatus("no-key");
      return;
    }

    let cancelled = false;

    async function run() {
      try {
        const ciphertext = fromBase64(wrappedEncryptionKey!);
        const sharedSecret = await decapsulate(ciphertext, privateKey!);
        if (!cancelled) {
          setProjectKey(projectId, sharedSecret);
          setStatus("ready");
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
          setError(
            "Could not decrypt this project. You may need to upload a different recovery file.",
          );
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [loaded, privateKey, projectId, wrappedEncryptionKey, getProjectKey, setProjectKey]);

  return { status, error };
}
