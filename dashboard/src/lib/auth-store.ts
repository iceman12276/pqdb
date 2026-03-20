/**
 * In-memory JWT token store with optional sessionStorage persistence.
 * Tokens live in a module-level variable (cleared on page reload).
 * When persist=true, tokens are also written to sessionStorage for tab-persistence.
 */

const SESSION_KEY = "pqdb-tokens";

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

let memoryTokens: TokenPair | null = null;

export function getTokens(): TokenPair | null {
  if (memoryTokens) return memoryTokens;
  // Fallback: try sessionStorage
  if (typeof sessionStorage !== "undefined") {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as TokenPair;
        memoryTokens = parsed;
        return parsed;
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
  }
  return null;
}

export function getAccessToken(): string | null {
  return getTokens()?.access_token ?? null;
}

export function setTokens(
  tokens: TokenPair,
  options?: { persist?: boolean },
): void {
  memoryTokens = tokens;
  if (options?.persist && typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(tokens));
  }
}

const SERVICE_KEY_PREFIX = "pqdb_service_key_";

export function clearTokens(): void {
  memoryTokens = null;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(SESSION_KEY);
    // Clear cached service keys to prevent stale keys after logout
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(SERVICE_KEY_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      sessionStorage.removeItem(k);
    }
  }
}
