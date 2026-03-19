import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { ProjectList } from "~/components/project-list";

export const Route = createFileRoute("/projects/")({
  component: ProjectsPage,
});

function ProjectsPage() {
  return (
    <AuthGuard>
      <ProjectList />
    </AuthGuard>
  );
}
