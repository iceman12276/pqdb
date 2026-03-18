import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/")({
  component: ProjectsPage,
});

function ProjectsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Projects</h1>
      <p className="mt-2 text-muted-foreground">
        Your projects will appear here.
      </p>
    </div>
  );
}
