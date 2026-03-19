import * as React from "react";
import { Search, Settings, Plug } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { ProjectSelector } from "./project-selector";
import { ConnectPopup } from "./connect-popup";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useNavigate } from "~/lib/navigation";
import type { Project } from "~/lib/projects";

export function TopBar() {
  const navigate = useNavigate();
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(
    null,
  );

  function handleProjectSelect(project: Project) {
    setSelectedProject(project);
    navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
  }

  return (
    <header
      data-testid="top-bar"
      className="flex h-14 items-center justify-between border-b border-border bg-background px-4"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
        >
          Account
        </button>
        <span className="text-muted-foreground">/</span>
        <ProjectSelector
          selectedProjectId={selectedProject?.id ?? null}
          onProjectSelect={handleProjectSelect}
        />
      </div>

      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plug className="h-4 w-4" />
            Connect
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96">
            <ConnectPopup
              projectId={selectedProject?.id ?? null}
              projectName={selectedProject?.name ?? null}
            />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Search (Cmd+K)"
        >
          <Search className="h-4 w-4" />
        </button>
        <ThemeToggle />
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
