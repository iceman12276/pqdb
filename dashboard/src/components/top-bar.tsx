import * as React from "react";
import { Search, Settings, Plug, LogOut } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { ProjectSelector } from "./project-selector";
import { BranchSelector } from "./branch-selector";
import { ConnectPopup } from "./connect-popup";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useNavigate } from "~/lib/navigation";
import { useParams } from "@tanstack/react-router";
import { clearTokens } from "~/lib/auth-store";
import { getActiveBranch, setActiveBranch } from "~/lib/branch-store";
import type { Project } from "~/lib/projects";

export function TopBar() {
  const navigate = useNavigate();
  const { projectId: urlProjectId } = useParams({ strict: false }) as {
    projectId?: string;
  };
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(
    null,
  );
  const [activeBranch, setActiveBranchState] = React.useState<string | null>(
    () => getActiveBranch(),
  );

  function handleProjectSelect(project: Project) {
    setSelectedProject(project);
    // Reset branch when switching projects
    setActiveBranch(null);
    setActiveBranchState(null);
    navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
  }

  function handleBranchChange(branch: string | null) {
    setActiveBranch(branch);
    setActiveBranchState(branch);
  }

  return (
    <header
      data-testid="top-bar"
      className="flex h-14 items-center justify-between border-b border-border bg-background px-4"
    >
      <div className="flex items-center gap-3">
        <Popover>
          <PopoverTrigger
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Account
          </PopoverTrigger>
          <PopoverContent align="start" className="w-40 p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-accent"
              onClick={() => {
                clearTokens();
                navigate({ to: "/login" });
              }}
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </PopoverContent>
        </Popover>
        <span className="text-muted-foreground">/</span>
        <ProjectSelector
          selectedProjectId={selectedProject?.id ?? null}
          onProjectSelect={handleProjectSelect}
        />
        {(selectedProject?.id ?? urlProjectId) && (
          <>
            <span className="text-muted-foreground">/</span>
            <BranchSelector
              projectId={(selectedProject?.id ?? urlProjectId)!}
              activeBranch={activeBranch}
              onBranchChange={handleBranchChange}
            />
          </>
        )}
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
          onClick={() => {
            const pid = selectedProject?.id ?? urlProjectId;
            if (pid) {
              navigate({
                to: "/projects/$projectId/settings",
                params: { projectId: pid },
              });
            }
          }}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
