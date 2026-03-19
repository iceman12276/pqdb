/**
 * ProjectContext — shared React context for the current project + service API key.
 *
 * When a project is loaded, fetches a service API key from the backend
 * via POST /v1/projects/{id}/keys/service-key. The key is held in memory
 * only (never persisted to localStorage/sessionStorage).
 *
 * Child components use `useProjectContext()` to get the apiKey for /v1/db/* calls.
 */

import * as React from "react";
import { fetchProject, fetchServiceKey, type Project } from "./projects";

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
        const [proj, keyInfo] = await Promise.all([
          fetchProject(projectId),
          fetchServiceKey(projectId),
        ]);
        if (!cancelled) {
          setState({
            project: proj,
            apiKey: keyInfo.key,
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
