import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchProject, type Project } from "~/lib/projects";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectOverviewPage,
});

function ProjectOverviewPage() {
  const { projectId } = Route.useParams();
  const [project, setProject] = React.useState<Project | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetchProject(projectId)
      .then((data) => {
        setProject(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [projectId]);

  if (loading) {
    return (
      <AuthGuard>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      </AuthGuard>
    );
  }

  if (!project) {
    return (
      <AuthGuard>
        <div className="text-center py-12">
          <p className="text-destructive">Project not found</p>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div>
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <p className="mt-2 text-muted-foreground">
          Project overview — details will be added in US-046.
        </p>
      </div>
    </AuthGuard>
  );
}
