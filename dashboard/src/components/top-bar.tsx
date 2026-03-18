import { Search, Settings, Plug } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

export function TopBar() {
  return (
    <header
      data-testid="top-bar"
      className="flex h-14 items-center justify-between border-b border-border bg-background px-4"
    >
      <div className="flex items-center gap-3">
        <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent">
          Account
        </button>
        <span className="text-muted-foreground">/</span>
        <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent">
          Project
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Plug className="h-4 w-4" />
          Connect
        </button>
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
