import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import {
  fetchProjectOverview,
  type ProjectOverview,
} from "~/lib/project-overview";
import { restoreProject } from "~/lib/projects";

function StatusCard({
  title,
  value,
  loading,
}: {
  title: string;
  value: React.ReactNode;
  loading: boolean;
}) {
  return (
    <Card data-testid={`status-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-6 w-20" />
        ) : (
          <div className="text-2xl font-bold">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}

export function ProjectOverviewPage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data: overview, isLoading, error } = useQuery<ProjectOverview>({
    queryKey: ["project-overview", projectId],
    queryFn: () => fetchProjectOverview(projectId),
  });

  const restoreMutation = useMutation({
    mutationFn: () => restoreProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  if (error) {
    return (
      <div className="text-center py-12" data-testid="overview-error">
        <p className="text-destructive">Failed to load project overview</p>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="project-overview">
      <div>
        <h1 className="text-2xl font-bold">
          {isLoading ? (
            <Skeleton className="h-8 w-48" />
          ) : (
            overview?.name
          )}
        </h1>
        {overview && (
          <div className="mt-2 flex items-center gap-2">
            <Badge
              variant={overview.status === "active" ? "default" : "secondary"}
              data-testid="project-status-badge"
            >
              {overview.status}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {overview.region}
            </span>
          </div>
        )}
      </div>

      {/* Paused Banner */}
      {overview?.status === "paused" && (
        <Alert variant="destructive" data-testid="paused-banner">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>
              This project is paused. Data operations are blocked. Restore to
              resume.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => restoreMutation.mutate()}
              disabled={restoreMutation.isPending}
            >
              {restoreMutation.isPending ? "Restoring..." : "Restore"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Connection Info */}
      {overview?.database_name && (
        <Card data-testid="connection-info">
          <CardHeader>
            <CardTitle>Connection Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 font-mono text-sm">
            <div>
              <span className="text-muted-foreground">Project URL: </span>
              <span data-testid="project-url">
                {typeof window !== "undefined"
                  ? window.location.origin
                  : ""}/v1/db
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Database: </span>
              <span data-testid="database-name">{overview.database_name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Project ID: </span>
              <span>{overview.project_id}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Status Cards */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Project Status</h2>
        <div
          className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6"
          data-testid="status-cards"
        >
          <StatusCard
            title="STATUS"
            value={
              <Badge variant={overview?.status === "active" ? "default" : "secondary"}>
                {overview?.status ?? "unknown"}
              </Badge>
            }
            loading={isLoading}
          />
          <StatusCard
            title="TABLES"
            value={overview?.tables_count ?? 0}
            loading={isLoading}
          />
          <StatusCard
            title="ENCRYPTION"
            value={overview?.encryption ?? "N/A"}
            loading={isLoading}
          />
          <StatusCard
            title="HMAC KEY"
            value="v1"
            loading={isLoading}
          />
          <StatusCard
            title="AUTH USERS"
            value={overview?.auth_users_count ?? 0}
            loading={isLoading}
          />
          <StatusCard
            title="RLS POLICIES"
            value={overview?.rls_policies_count ?? 0}
            loading={isLoading}
          />
        </div>
      </div>

      {/* Total Requests */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Total Requests</h2>
        <div
          className="grid grid-cols-2 gap-4 md:grid-cols-4"
          data-testid="request-cards"
        >
          <StatusCard
            title="DATABASE REQUESTS"
            value={overview?.database_requests ?? 0}
            loading={isLoading}
          />
          <StatusCard
            title="AUTH REQUESTS"
            value={overview?.auth_requests ?? 0}
            loading={isLoading}
          />
          <StatusCard
            title="REALTIME REQUESTS"
            value={0}
            loading={isLoading}
          />
          <StatusCard
            title="MCP REQUESTS"
            value={0}
            loading={isLoading}
          />
        </div>
      </div>
    </div>
  );
}
