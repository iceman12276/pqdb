import {
  LayoutDashboard,
  Table2,
  Terminal,
  GitBranch,
  GitCommitHorizontal,
  Network,
  FunctionSquare,
  Zap,
  Shield,
  Radio,
  ScrollText,
  Bot,
  KeyRound,
  Settings,
  List,
  Puzzle,
  ListTree,
  Megaphone,
  Link2,
  HardDrive,
  Database,
} from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { fetchProject } from "~/lib/projects";

export interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Path suffix appended to `/projects/:id`. Empty string = project overview. */
  path: string;
  disabled?: boolean;
}

export const sidebarNavItems: NavItem[] = [
  { label: "Project Overview", icon: LayoutDashboard, path: "" },
  { label: "Table Editor", icon: Table2, path: "/tables" },
  { label: "Query Playground", icon: Terminal, path: "/sql" },
  { label: "Schema", icon: Network, path: "/schema" },
  { label: "Functions", icon: FunctionSquare, path: "/functions" },
  { label: "Triggers", icon: Zap, path: "/triggers" },
  { label: "Enums", icon: List, path: "/enums" },
  { label: "Extensions", icon: Puzzle, path: "/extensions" },
  { label: "Authentication", icon: Shield, path: "/auth" },
  { label: "Realtime", icon: Radio, path: "/realtime" },
  { label: "Logs", icon: ScrollText, path: "/logs" },
  { label: "Indexes", icon: ListTree, path: "/indexes" },
  { label: "Publications", icon: Megaphone, path: "/publications" },
  { label: "Branches", icon: GitBranch, path: "/branches" },
  { label: "MCP", icon: Bot, path: "/mcp" },
  { label: "Wrappers", icon: Link2, path: "/wrappers" },
  { label: "Migrations", icon: GitCommitHorizontal, path: "/migrations" },
  { label: "Backups", icon: HardDrive, path: "/backups" },
  { label: "Replication", icon: Database, path: "/replication" },
  { label: "API Keys", icon: KeyRound, path: "/keys" },
  { label: "Project Settings", icon: Settings, path: "/settings" },
];

/** Nav items that require data access and should be disabled when paused. */
const pauseDisabledPaths = new Set(["/tables", "/sql", "/schema", "/functions", "/triggers", "/enums", "/extensions", "/indexes", "/publications", "/wrappers", "/backups", "/replication"]);

export function SidebarNav({ projectStatus }: { projectStatus?: string } = {}) {
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId!),
    enabled: !!projectId && projectStatus === undefined,
  });

  const status = projectStatus ?? project?.status;

  return (
    <nav
      data-testid="sidebar-nav"
      className="flex h-full w-60 flex-col border-r border-border bg-sidebar px-3 py-4"
    >
      <div className="mb-6 px-3">
        <span className="text-lg font-semibold text-sidebar-foreground">
          pqdb
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-1">
        {sidebarNavItems.map((item) => {
          const href = projectId
            ? `/projects/${projectId}${item.path}`
            : "/projects";

          const isDisabled =
            item.disabled ||
            (status === "paused" && pauseDisabledPaths.has(item.path));

          return (
            <li key={item.label}>
              <Link
                to={isDisabled ? undefined! : href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isDisabled
                    ? "cursor-not-allowed text-muted-foreground opacity-50"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
                aria-disabled={isDisabled}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
