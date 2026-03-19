/**
 * EncryptionContext — shared React context for client-side encryption key state.
 *
 * When "unlocked", the SDK can decrypt encrypted columns client-side.
 * When "locked", encrypted columns display as [encrypted].
 *
 * Shared between Table Editor (US-049) and Query Playground (US-050).
 */

import * as React from "react";

interface EncryptionState {
  /** Whether encryption key is loaded and decryption is active */
  isUnlocked: boolean;
  /** The encryption key (opaque to consumers) */
  encryptionKey: string | null;
  /** Unlock with a key */
  unlock: (key: string) => void;
  /** Lock (clear key) */
  lock: () => void;
}

const EncryptionContext = React.createContext<EncryptionState>({
  isUnlocked: false,
  encryptionKey: null,
  unlock: () => {},
  lock: () => {},
});

export function EncryptionProvider({ children }: { children: React.ReactNode }) {
  const [encryptionKey, setEncryptionKey] = React.useState<string | null>(null);

  const unlock = React.useCallback((key: string) => {
    setEncryptionKey(key);
  }, []);

  const lock = React.useCallback(() => {
    setEncryptionKey(null);
  }, []);

  const value = React.useMemo(
    () => ({
      isUnlocked: encryptionKey !== null,
      encryptionKey,
      unlock,
      lock,
    }),
    [encryptionKey, unlock, lock],
  );

  return (
    <EncryptionContext.Provider value={value}>
      {children}
    </EncryptionContext.Provider>
  );
}

export function useEncryption(): EncryptionState {
  return React.useContext(EncryptionContext);
}
