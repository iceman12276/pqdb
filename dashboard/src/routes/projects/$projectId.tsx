import * as React from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { ProjectDecapsulateGate } from "~/lib/project-decapsulate-gate";
import { fetchProject, type Project } from "~/lib/projects";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectDecapsulateLoader projectId={projectId} />
      <Outlet />
    </AuthGuard>
  );
}

/**
 * Fetches the project detail and triggers PQC decapsulation of the
 * wrapped_encryption_key. Renders banners for error states.
 */
function ProjectDecapsulateLoader({ projectId }: { projectId: string }) {
  const [project, setProject] = React.useState<Project | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    fetchProject(projectId)
      .then((p) => {
        if (!cancelled) {
          setProject(p);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!loaded) return null;

  return (
    <ProjectDecapsulateGate
      projectId={projectId}
      wrappedEncryptionKey={project?.wrapped_encryption_key ?? null}
    >
      {null}
    </ProjectDecapsulateGate>
  );
}
