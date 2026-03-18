import {
  LayoutDashboard,
  Table2,
  Terminal,
  GitBranch,
  Shield,
  Radio,
  ScrollText,
  Bot,
  Settings,
} from "lucide-react";
import { cn } from "~/lib/utils";

export interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  disabled?: boolean;
}

export const sidebarNavItems: NavItem[] = [
  {
    label: "Project Overview",
    icon: LayoutDashboard,
    href: "/project/overview",
  },
  { label: "Table Editor", icon: Table2, href: "/project/tables" },
  { label: "Query Playground", icon: Terminal, href: "/project/query" },
  { label: "Schema", icon: GitBranch, href: "/project/schema" },
  { label: "Authentication", icon: Shield, href: "/project/auth" },
  {
    label: "Realtime",
    icon: Radio,
    href: "/project/realtime",
    disabled: true,
  },
  { label: "Logs", icon: ScrollText, href: "/project/logs" },
  { label: "MCP", icon: Bot, href: "/project/mcp", disabled: true },
  {
    label: "Project Settings",
    icon: Settings,
    href: "/project/settings",
  },
];

export function SidebarNav() {
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
        {sidebarNavItems.map((item) => (
          <li key={item.label}>
            <a
              href={item.disabled ? undefined : item.href}
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
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
