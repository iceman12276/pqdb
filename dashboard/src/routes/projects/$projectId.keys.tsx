import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { ApiKeysPage } from "~/components/api-keys-page";
import { Skeleton } from "~/components/ui/skeleton";
import { ProjectProvider, useProjectContext } from "~/lib/project-context";

export const Route = createFileRoute("/projects/$projectId/keys")({
  component: ProjectKeysPage,
});

function ProjectKeysPage() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectProvider projectId={projectId}>
        <ProjectKeysInner projectId={projectId} />
      </ProjectProvider>
    </AuthGuard>
  );
}

function ProjectKeysInner({ projectId }: { projectId: string }) {
  const { apiKey, loading } = useProjectContext();

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return <ApiKeysPage projectId={projectId} apiKey={apiKey ?? undefined} />;
}
