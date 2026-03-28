import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  Trash2,
  ArrowUpCircle,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  listBranches,
  deleteBranch,
  promoteBranch,
  rebaseBranch,
} from "~/lib/branches";
import { setActiveBranch } from "~/lib/branch-store";

interface BranchesPageProps {
  projectId: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "active":
      return "default";
    case "merging":
    case "rebasing":
      return "secondary";
    default:
      return "outline";
  }
}

export function BranchesPage({ projectId }: BranchesPageProps) {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [promoteTarget, setPromoteTarget] = React.useState<string | null>(null);

  const {
    data: branches,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => listBranches(projectId),
    enabled: !!projectId,
  });

  const deleteMutation = useMutation({
    mutationFn: (branchName: string) => deleteBranch(projectId, branchName),
    onSuccess: () => {
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (branchName: string) =>
      promoteBranch(projectId, branchName, true),
    onSuccess: () => {
      setPromoteTarget(null);
      setActiveBranch(null); // Reset to main after promote
      queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
    },
  });

  const rebaseMutation = useMutation({
    mutationFn: (branchName: string) => rebaseBranch(projectId, branchName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
    },
  });

  if (isLoading) {
    return (
      <div data-testid="branches-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load branches</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Branches
        </h2>
      </div>

      {branches && branches.length === 0 ? (
        <Card className="p-8 text-center">
          <GitBranch className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            No branches yet. Create a branch from the branch selector in the
            header to get started.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {branches?.map((branch) => (
            <Card key={branch.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <GitBranch className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{branch.name}</span>
                  <Badge variant={statusVariant(branch.status)}>
                    {branch.status}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    Created {formatDate(branch.created_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`rebase-branch-${branch.name}`}
                    onClick={() => rebaseMutation.mutate(branch.name)}
                    disabled={
                      branch.status !== "active" || rebaseMutation.isPending
                    }
                    title="Rebase from main"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`promote-branch-${branch.name}`}
                    onClick={() => setPromoteTarget(branch.name)}
                    disabled={branch.status !== "active"}
                    title="Promote to main"
                  >
                    <ArrowUpCircle className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`delete-branch-${branch.name}`}
                    onClick={() => setDeleteTarget(branch.name)}
                    title="Delete branch"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Branch
            </DialogTitle>
            <DialogDescription>
              This will permanently delete the branch database. All data in the
              branch &quot;{deleteTarget}&quot; will be lost. This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Promote Confirmation Dialog */}
      <Dialog
        open={promoteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setPromoteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Promote Branch
            </DialogTitle>
            <DialogDescription>
              This will replace the main database with this branch. Other
              branches will become stale and may need to be rebased or deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (promoteTarget) promoteMutation.mutate(promoteTarget);
              }}
              disabled={promoteMutation.isPending}
            >
              {promoteMutation.isPending ? "Promoting..." : "Promote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
