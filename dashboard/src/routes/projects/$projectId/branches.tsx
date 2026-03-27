import { createFileRoute } from "@tanstack/react-router";
import { BranchesPage } from "~/components/branches-page";

export const Route = createFileRoute("/projects/$projectId/branches")({
  component: ProjectBranchesRoute,
});

function ProjectBranchesRoute() {
  const { projectId } = Route.useParams();
  return <BranchesPage projectId={projectId} />;
}
