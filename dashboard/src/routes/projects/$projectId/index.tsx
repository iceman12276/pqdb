import { createFileRoute } from "@tanstack/react-router";
import { ProjectOverviewPage } from "~/components/project-overview-page";

export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectOverviewRoute,
});

function ProjectOverviewRoute() {
  const { projectId } = Route.useParams();
  return <ProjectOverviewPage projectId={projectId} />;
}
