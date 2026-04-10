/**
 * KeypairContext — React context for ML-KEM-768 keypair management.
 *
 * Loads the developer's keypair from IndexedDB on mount and exposes it via
 * useKeypair(). Also preserves the legacy envelope-key API surface so that
 * existing consumers (create-project, reveal-encryption-key, table routes,
 * login, signup, change-password) continue to work during the migration to
 * full PQC encapsulate/decapsulate (US-006, US-007).
 *
 * Replaces envelope-key-context.tsx.
 */

import * as React from "react";
import {
  unwrapKey,
  wrapKey,
  generateEncryptionKey,
} from "./envelope-crypto";
import { getAccessToken, onLogin, onLogout } from "./auth-store";
import { loadKeypair } from "./keypair-store";

/* ------------------------------------------------------------------ */
/*  Keypair context (new PQC API)                                     */
/* ------------------------------------------------------------------ */

export interface KeypairState {
  publicKey: Uint8Array | null;
  privateKey: Uint8Array | null;
  loaded: boolean;
  error: string | null;
}

const KeypairContext = React.createContext<KeypairState>({
  publicKey: null,
  privateKey: null,
  loaded: false,
  error: null,
});

/**
 * Decode the `sub` claim from a JWT without verifying the signature.
 * Only used to key the IndexedDB lookup — the token is already server-issued.
 */
function developerIdFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded);
    const claims = JSON.parse(decoded) as { sub?: string };
    return claims.sub ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Legacy envelope-key context (backward compat)                     */
/* ------------------------------------------------------------------ */

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
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

const ENVELOPE_KEYS_STORAGE_KEY = "pqdb_envelope_keys";

function loadKeysFromStorage(): Map<string, string> {
  if (typeof sessionStorage === "undefined") return new Map();
  try {
    const stored = sessionStorage.getItem(ENVELOPE_KEYS_STORAGE_KEY);
    if (stored) return new Map(Object.entries(JSON.parse(stored)));
  } catch {
    // Corrupted data — ignore
  }
  return new Map();
}

function saveKeysToStorage(keys: Map<string, string>): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(
    ENVELOPE_KEYS_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(keys)),
  );
}

function clearKeysFromStorage(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(ENVELOPE_KEYS_STORAGE_KEY);
}

/* ------------------------------------------------------------------ */
/*  Combined provider                                                 */
/* ------------------------------------------------------------------ */

export function KeypairProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  /* --- Keypair state (new) --- */
  const [keypairState, setKeypairState] = React.useState<KeypairState>({
    publicKey: null,
    privateKey: null,
    loaded: false,
    error: null,
  });

  // Track the access token reactively so the keypair loads both on mount
  // (page refresh with existing token) AND after a fresh login/signup.
  const [token, setToken] = React.useState<string | null>(() =>
    getAccessToken(),
  );

  // Subscribe to auth state changes
  React.useEffect(() => {
    const unsubLogin = onLogin(() => setToken(getAccessToken()));
    const unsubLogout = onLogout(() => {
      setToken(null);
      setKeypairState({
        publicKey: null,
        privateKey: null,
        loaded: false,
        error: null,
      });
    });
    return () => {
      unsubLogin();
      unsubLogout();
    };
  }, []);

  // Load keypair from IndexedDB whenever token changes
  React.useEffect(() => {
    if (!token) return;

    const developerId = developerIdFromToken(token);
    if (!developerId) return;

    let cancelled = false;

    loadKeypair(developerId)
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          setKeypairState({
            publicKey: stored.publicKey,
            privateKey: stored.secretKey,
            loaded: true,
            error: null,
          });
        } else {
          setKeypairState({
            publicKey: null,
            privateKey: null,
            loaded: true,
            error: "missing",
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setKeypairState({
          publicKey: null,
          privateKey: null,
          loaded: true,
          error: "missing",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  /* --- Legacy envelope-key state --- */
  const [wrappingKey, setWrappingKeyState] = React.useState<CryptoKey | null>(
    null,
  );
  const [encryptionKeys, setEncryptionKeys] = React.useState<
    Map<string, string>
  >(() => loadKeysFromStorage());

  // Sync to sessionStorage whenever encryptionKeys changes
  React.useEffect(() => {
    if (encryptionKeys.size > 0) {
      saveKeysToStorage(encryptionKeys);
    }
  }, [encryptionKeys]);

  // Clear legacy envelope keys on logout
  React.useEffect(() => {
    return onLogout(() => {
      setWrappingKeyState(null);
      setEncryptionKeys(new Map());
      clearKeysFromStorage();
    });
  }, []);

  const wrappingKeyRef = React.useRef<CryptoKey | null>(null);
  wrappingKeyRef.current = wrappingKey;

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
        if (currentKeys.has(project.id)) continue;

        try {
          if (project.wrapped_encryption_key) {
            const blob = base64ToUint8Array(project.wrapped_encryption_key);
            const decryptedKey = await unwrapKey(blob, wk);
            newEntries.push([project.id, decryptedKey]);
          } else {
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

  // Auto-unwrap project keys when wrapping key becomes available
  React.useEffect(() => {
    if (!wrappingKey) return;

    let cancelled = false;

    async function fetchAndUnwrap() {
      const token = getAccessToken();
      if (!token) return;

      try {
        const res = await fetch("/v1/projects", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;

        const projects = await res.json();
        if (!cancelled) {
          await unwrapProjectKeys(projects);
        }
      } catch (err) {
        console.warn("[pqdb] fetchAndUnwrap error:", err);
      }
    }

    fetchAndUnwrap();

    return () => {
      cancelled = true;
    };
  }, [wrappingKey, unwrapProjectKeys]);

  const envelopeValue = React.useMemo(
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
    <KeypairContext.Provider value={keypairState}>
      <EnvelopeKeyContext.Provider value={envelopeValue}>
        {children}
      </EnvelopeKeyContext.Provider>
    </KeypairContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                             */
/* ------------------------------------------------------------------ */

/** New PQC keypair hook: {publicKey, privateKey, loaded, error}. */
export function useKeypair(): KeypairState {
  return React.useContext(KeypairContext);
}

/** Legacy envelope-key hook — backward compat for existing consumers. */
export function useEnvelopeKeys(): EnvelopeKeyState {
  return React.useContext(EnvelopeKeyContext);
}

// Re-export EnvelopeKeyProvider as an alias so __root.tsx migration is clear
export { KeypairProvider as EnvelopeKeyProvider };
