import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  return (
    <AuthGuard>
      <Outlet />
    </AuthGuard>
  );
}
