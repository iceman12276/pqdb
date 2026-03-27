import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { IndexesPage } from "~/components/indexes-page";
import { Skeleton } from "~/components/ui/skeleton";
import { ProjectProvider, useProjectContext } from "~/lib/project-context";

export const Route = createFileRoute("/projects/$projectId/indexes")({
  component: IndexesRoute,
});

function IndexesRoute() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectProvider projectId={projectId}>
        <IndexesRouteInner projectId={projectId} />
      </ProjectProvider>
    </AuthGuard>
  );
}

function IndexesRouteInner({ projectId }: { projectId: string }) {
  const { project, apiKey, loading, error } = useProjectContext();

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">{error ?? "Project not found"}</p>
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          No API key found. Create an API key to view indexes.
        </p>
      </div>
    );
  }

  return <IndexesPage projectId={projectId} />;
}
