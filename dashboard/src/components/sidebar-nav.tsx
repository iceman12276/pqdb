import {
  LayoutDashboard,
  Table2,
  Terminal,
  GitBranch,
  Shield,
  Radio,
  ScrollText,
  Bot,
  KeyRound,
  Settings,
} from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "~/lib/utils";

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
  { label: "Schema", icon: GitBranch, path: "/schema" },
  { label: "Authentication", icon: Shield, path: "/auth" },
  { label: "Realtime", icon: Radio, path: "/realtime" },
  { label: "Logs", icon: ScrollText, path: "/logs" },
  { label: "MCP", icon: Bot, path: "/mcp" },
  { label: "API Keys", icon: KeyRound, path: "/keys" },
  { label: "Project Settings", icon: Settings, path: "/settings" },
];

export function SidebarNav() {
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };

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

          return (
            <li key={item.label}>
              <Link
                to={item.disabled ? undefined! : href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  item.disabled
                    ? "cursor-not-allowed text-muted-foreground opacity-50"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
                aria-disabled={item.disabled}
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
