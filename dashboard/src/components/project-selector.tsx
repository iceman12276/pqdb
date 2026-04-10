import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { fetchProjects, type Project } from "~/lib/projects";

interface ProjectSelectorProps {
  selectedProjectId: string | null;
  onProjectSelect: (project: Project) => void;
}

export function ProjectSelector({
  selectedProjectId,
  onProjectSelect,
}: ProjectSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
  });

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selected = projects.find((p) => p.id === selectedProjectId);

  return (
    <div ref={ref} className="relative" data-testid="project-selector">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
        onClick={() => setOpen(!open)}
      >
        {selected ? selected.name : "Select project"}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 min-w-[200px] rounded-md border border-border bg-popover p-1 shadow-md">
          <Link
            to="/projects"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm font-medium hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            All Projects
          </Link>
          <div
            data-testid="all-projects-divider"
            className="my-1 h-px bg-border"
            role="separator"
          />
          {projects.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No projects
            </p>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                onClick={() => {
                  onProjectSelect(project);
                  setOpen(false);
                }}
              >
                {project.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
