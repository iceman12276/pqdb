import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { PerformancePage } from "~/components/performance-page";
import { Skeleton } from "~/components/ui/skeleton";
import { ProjectProvider, useProjectContext } from "~/lib/project-context";

export const Route = createFileRoute("/projects/$projectId/performance")({
  component: PerformanceRoute,
});

function PerformanceRoute() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectProvider projectId={projectId}>
        <PerformanceRouteInner projectId={projectId} />
      </ProjectProvider>
    </AuthGuard>
  );
}

function PerformanceRouteInner({ projectId }: { projectId: string }) {
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
          No API key found. Create an API key to view performance findings.
        </p>
      </div>
    );
  }

  return <PerformancePage projectId={projectId} apiKey={apiKey} />;
}
