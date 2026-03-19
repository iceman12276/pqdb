import { createFileRoute } from "@tanstack/react-router";
import { ProjectLogsPage } from "~/components/project-logs-page";

export const Route = createFileRoute("/projects/$projectId/logs")({
  component: ProjectLogsRoute,
});

function ProjectLogsRoute() {
  const { projectId } = Route.useParams();
  return <ProjectLogsPage projectId={projectId} />;
}
