import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { TriggersPage } from "~/components/triggers-page";
import { Skeleton } from "~/components/ui/skeleton";
import { ProjectProvider, useProjectContext } from "~/lib/project-context";

export const Route = createFileRoute("/projects/$projectId/triggers")({
  component: TriggersRoute,
});

function TriggersRoute() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectProvider projectId={projectId}>
        <TriggersRouteInner projectId={projectId} />
      </ProjectProvider>
    </AuthGuard>
  );
}

function TriggersRouteInner({ projectId }: { projectId: string }) {
  const { project, apiKey, loading, error } = useProjectContext();

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
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
          No API key found. Create an API key to view triggers.
        </p>
      </div>
    );
  }

  return <TriggersPage projectId={projectId} apiKey={apiKey} />;
}
