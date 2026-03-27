import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { listBranches, createBranch, type Branch } from "~/lib/branches";

interface BranchSelectorProps {
  projectId: string;
  activeBranch: string | null;
  onBranchChange: (branch: string | null) => void;
}

export function BranchSelector({
  projectId,
  activeBranch,
  onBranchChange,
}: BranchSelectorProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState("");

  const { data: branches = [] } = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => listBranches(projectId),
    enabled: !!projectId,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => createBranch(projectId, name),
    onSuccess: (branch: Branch) => {
      queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
      setShowCreateDialog(false);
      setNewBranchName("");
      onBranchChange(branch.name);
    },
  });

  const displayName = activeBranch ?? "main";

  return (
    <div data-testid="branch-selector">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-testid="branch-selector-trigger"
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          <GitBranch className="h-4 w-4" />
          {displayName}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2">
          <div className="space-y-1">
            <button
              type="button"
              data-testid="branch-option-main"
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                onBranchChange(null);
                setOpen(false);
              }}
            >
              <span className="flex items-center gap-2">
                <GitBranch className="h-3.5 w-3.5" />
                main
              </span>
              {activeBranch === null && (
                <Badge variant="secondary" className="text-xs">
                  active
                </Badge>
              )}
            </button>

            {branches.map((branch) => (
              <button
                key={branch.id}
                type="button"
                data-testid={`branch-option-${branch.name}`}
                className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                onClick={() => {
                  onBranchChange(branch.name);
                  setOpen(false);
                }}
              >
                <span className="flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5" />
                  {branch.name}
                </span>
                {branch.status !== "active" && (
                  <Badge variant="outline" className="text-xs">
                    {branch.status}
                  </Badge>
                )}
                {activeBranch === branch.name && (
                  <Badge variant="secondary" className="text-xs">
                    active
                  </Badge>
                )}
              </button>
            ))}

            <div className="border-t border-border pt-1 mt-1">
              <button
                type="button"
                data-testid="create-branch-btn"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => {
                  setOpen(false);
                  setShowCreateDialog(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                Create Branch
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Branch</DialogTitle>
            <DialogDescription>
              Create a new database branch from main. The branch will be an
              isolated copy of the current database.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="branch-name">Branch Name</Label>
            <Input
              id="branch-name"
              data-testid="branch-name-input"
              placeholder="feature-name"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers, hyphens, and underscores only.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateDialog(false)}
            >
              Cancel
            </Button>
            <Button
              data-testid="create-branch-submit"
              onClick={() => createMutation.mutate(newBranchName)}
              disabled={
                newBranchName.trim().length === 0 || createMutation.isPending
              }
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
          {createMutation.isError && (
            <p className="text-sm text-destructive">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Failed to create branch"}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
