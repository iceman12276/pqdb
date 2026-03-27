/**
 * Module-level store for the currently active branch.
 * When a branch is selected, the API client reads this to attach the x-branch header.
 * null means "main" (no header).
 */

const SESSION_KEY = "pqdb-active-branch";

let activeBranch: string | null = null;

export function getActiveBranch(): string | null {
  if (activeBranch !== null) return activeBranch;
  if (typeof sessionStorage !== "undefined") {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      activeBranch = stored;
      return stored;
    }
  }
  return null;
}

export function setActiveBranch(branch: string | null): void {
  activeBranch = branch;
  if (typeof sessionStorage !== "undefined") {
    if (branch) {
      sessionStorage.setItem(SESSION_KEY, branch);
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }
}
