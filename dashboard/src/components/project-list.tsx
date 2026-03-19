import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ProjectCard } from "~/components/project-card";
import { CreateProjectDialog } from "~/components/create-project-dialog";
import { fetchProjects, type ProjectCreateResponse } from "~/lib/projects";
import { useNavigate } from "~/lib/navigation";

export function ProjectList() {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const {
    data: projects,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
  });

  function handleCreated(project: ProjectCreateResponse) {
    setDialogOpen(false);
    navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
  }

  if (isLoading) {
    return (
      <div data-testid="project-list-loading" className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error ? error.message : "Failed to load projects"}
        </p>
      </div>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <div data-testid="empty-state" className="text-center py-12">
        <h2 className="text-lg font-medium">No projects yet</h2>
        <p className="mt-2 text-muted-foreground">
          Create your first project to get started.
        </p>
        <Button className="mt-4" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Project
        </Button>
        <CreateProjectDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={handleCreated}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Project
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() =>
              navigate({
                to: "/projects/$projectId",
                params: { projectId: project.id },
              })
            }
          />
        ))}
      </div>
      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />
    </div>
  );
}
