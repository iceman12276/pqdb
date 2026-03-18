/**
 * Navigation wrapper. Thin abstraction over window.location for testability.
 * Components import useNavigate from here so tests can mock it.
 */

import { useCallback } from "react";

export function useNavigate(): (path: string) => void {
  return useCallback((path: string) => {
    window.location.href = path;
  }, []);
}
