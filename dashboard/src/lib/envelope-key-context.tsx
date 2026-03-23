/**
 * EnvelopeKeyContext — React context for envelope encryption key management.
 *
 * Holds the wrapping key (derived from password via PBKDF2) and a map of
 * per-project encryption keys. When projects are loaded, wrapped blobs are
 * auto-unwrapped. Projects without a wrapped key get one auto-generated.
 */

import * as React from "react";
import {
  unwrapKey,
  wrapKey,
  generateEncryptionKey,
} from "./envelope-crypto";
import { getAccessToken, onLogout } from "./auth-store";

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export interface EnvelopeKeyState {
  wrappingKey: CryptoKey | null;
  encryptionKeys: Map<string, string>;
  setWrappingKey: (key: CryptoKey) => void;
  clearKeys: () => void;
  getEncryptionKey: (projectId: string) => string | null;
  addEncryptionKey: (projectId: string, key: string) => void;
  unwrapProjectKeys: (
    projects: Array<{ id: string; wrapped_encryption_key: string | null }>,
  ) => Promise<void>;
}

const EnvelopeKeyContext = React.createContext<EnvelopeKeyState>({
  wrappingKey: null,
  encryptionKeys: new Map(),
  setWrappingKey: () => {},
  clearKeys: () => {},
  getEncryptionKey: () => null,
  addEncryptionKey: () => {},
  unwrapProjectKeys: async () => {},
});

export function EnvelopeKeyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [wrappingKey, setWrappingKeyState] = React.useState<CryptoKey | null>(
    null,
  );
  const [encryptionKeys, setEncryptionKeys] = React.useState<
    Map<string, string>
  >(new Map());

  // Clear keys on logout
  React.useEffect(() => {
    return onLogout(() => {
      setWrappingKeyState(null);
      setEncryptionKeys(new Map());
    });
  }, []);

  // Use a ref to access wrappingKey in callbacks without stale closures
  const wrappingKeyRef = React.useRef<CryptoKey | null>(null);
  wrappingKeyRef.current = wrappingKey;

  // Use a ref for encryptionKeys to avoid stale closures
  const encryptionKeysRef = React.useRef<Map<string, string>>(encryptionKeys);
  encryptionKeysRef.current = encryptionKeys;

  const setWrappingKey = React.useCallback((key: CryptoKey) => {
    setWrappingKeyState(key);
  }, []);

  const clearKeys = React.useCallback(() => {
    setWrappingKeyState(null);
    setEncryptionKeys(new Map());
  }, []);

  const getEncryptionKey = React.useCallback(
    (projectId: string): string | null => {
      return encryptionKeys.get(projectId) ?? null;
    },
    [encryptionKeys],
  );

  const addEncryptionKey = React.useCallback(
    (projectId: string, key: string) => {
      setEncryptionKeys((prev) => {
        const next = new Map(prev);
        next.set(projectId, key);
        return next;
      });
    },
    [],
  );

  const unwrapProjectKeys = React.useCallback(
    async (
      projects: Array<{ id: string; wrapped_encryption_key: string | null }>,
    ) => {
      const wk = wrappingKeyRef.current;
      if (!wk) return;

      const currentKeys = encryptionKeysRef.current;
      const newEntries: Array<[string, string]> = [];

      for (const project of projects) {
        // Skip projects already in the map
        if (currentKeys.has(project.id)) continue;

        try {
          if (project.wrapped_encryption_key) {
            // Unwrap existing wrapped key
            const blob = base64ToUint8Array(project.wrapped_encryption_key);
            const decryptedKey = await unwrapKey(blob, wk);
            newEntries.push([project.id, decryptedKey]);
          } else {
            // Auto-generate a key, wrap it, PATCH to server
            const encKey = generateEncryptionKey();
            const wrappedBlob = await wrapKey(encKey, wk);
            const wrappedBase64 = uint8ArrayToBase64(wrappedBlob);

            const token = getAccessToken();
            const response = await fetch(`/v1/projects/${project.id}/encryption-key`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({
                wrapped_encryption_key: wrappedBase64,
              }),
            });

            if (!response.ok) {
              console.warn("Failed to store wrapped key for project", project.id, response.status);
              continue;
            }

            newEntries.push([project.id, encKey]);
          }
        } catch (error) {
          console.warn("Failed to unwrap key for project", project.id, error);
        }
      }

      if (newEntries.length > 0) {
        setEncryptionKeys((prev) => {
          const next = new Map(prev);
          for (const [id, key] of newEntries) {
            next.set(id, key);
          }
          return next;
        });
      }
    },
    [],
  );

  const value = React.useMemo(
    () => ({
      wrappingKey,
      encryptionKeys,
      setWrappingKey,
      clearKeys,
      getEncryptionKey,
      addEncryptionKey,
      unwrapProjectKeys,
    }),
    [
      wrappingKey,
      encryptionKeys,
      setWrappingKey,
      clearKeys,
      getEncryptionKey,
      addEncryptionKey,
      unwrapProjectKeys,
    ],
  );

  return (
    <EnvelopeKeyContext.Provider value={value}>
      {children}
    </EnvelopeKeyContext.Provider>
  );
}

export function useEnvelopeKeys(): EnvelopeKeyState {
  return React.useContext(EnvelopeKeyContext);
}
