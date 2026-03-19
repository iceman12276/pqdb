import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { AuthSettingsPage } from "~/components/auth-settings-page";

export const Route = createFileRoute("/projects/$projectId/auth")({
  component: ProjectAuthPage,
});

function ProjectAuthPage() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <AuthSettingsPage projectId={projectId} />
    </AuthGuard>
  );
}
