import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { ApiKeysPage } from "~/components/api-keys-page";

export const Route = createFileRoute("/projects/$projectId/keys")({
  component: ProjectKeysPage,
});

function ProjectKeysPage() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ApiKeysPage projectId={projectId} />
    </AuthGuard>
  );
}
