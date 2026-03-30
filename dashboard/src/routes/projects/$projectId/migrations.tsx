import { createFileRoute } from "@tanstack/react-router";
import { MigrationsPage } from "~/components/migrations-page";

export const Route = createFileRoute("/projects/$projectId/migrations")({
  component: ProjectMigrationsRoute,
});

function ProjectMigrationsRoute() {
  const { projectId } = Route.useParams();
  return <MigrationsPage projectId={projectId} />;
}
