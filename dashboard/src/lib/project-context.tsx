/**
 * ProjectContext — shared React context for the current project + service API key.
 *
 * When a project is loaded, fetches a service API key from the backend
 * via POST /v1/projects/{id}/keys/service-key. The key is cached in
 * sessionStorage per project ID to avoid creating duplicate keys on
 * every page navigation.
 *
 * Child components use `useProjectContext()` to get the apiKey for /v1/db/* calls.
 */

import * as React from "react";
import { fetchProject, fetchServiceKey, type Project } from "./projects";

const SERVICE_KEY_PREFIX = "pqdb_service_key_";

function getCachedServiceKey(projectId: string): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(SERVICE_KEY_PREFIX + projectId);
}

function cacheServiceKey(projectId: string, key: string): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(SERVICE_KEY_PREFIX + projectId, key);
  }
}

interface ProjectContextState {
  project: Project | null;
  apiKey: string | null;
  loading: boolean;
  error: string | null;
}

const ProjectContext = React.createContext<ProjectContextState>({
  project: null,
  apiKey: null,
  loading: true,
  error: null,
});

export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<ProjectContextState>({
    project: null,
    apiKey: null,
    loading: true,
    error: null,
  });

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const cachedKey = getCachedServiceKey(projectId);
        let key: string;

        const proj = await fetchProject(projectId);

        if (cachedKey) {
          // Verify the cached key still works by trying a lightweight call
          try {
            const testRes = await fetch(`/v1/db/introspect`, {
              headers: { apikey: cachedKey },
            });
            if (testRes.ok) {
              key = cachedKey;
            } else {
              // Cached key is stale — fetch a new one
              sessionStorage.removeItem(SERVICE_KEY_PREFIX + projectId);
              const info = await fetchServiceKey(projectId);
              cacheServiceKey(projectId, info.key);
              key = info.key;
            }
          } catch {
            // Network error — try fetching a new key
            sessionStorage.removeItem(SERVICE_KEY_PREFIX + projectId);
            const info = await fetchServiceKey(projectId);
            cacheServiceKey(projectId, info.key);
            key = info.key;
          }
        } else {
          const info = await fetchServiceKey(projectId);
          cacheServiceKey(projectId, info.key);
          key = info.key;
        }
        if (!cancelled) {
          setState({
            project: proj,
            apiKey: key,
            loading: false,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            project: null,
            apiKey: null,
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load project",
          });
        }
      }
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));
    load();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <ProjectContext.Provider value={state}>{children}</ProjectContext.Provider>
  );
}

export function useProjectContext(): ProjectContextState {
  return React.useContext(ProjectContext);
}
