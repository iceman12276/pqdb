import { useQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, CheckCircle2, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchMigrations, type MigrationEntry } from "~/lib/projects";

interface MigrationsPageProps {
  projectId: string;
}

function MigrationItem({
  entry,
  isCurrent,
}: {
  entry: MigrationEntry;
  isCurrent: boolean;
}) {
  return (
    <div
      data-testid="migration-item"
      className={`flex items-start gap-3 rounded-md border p-3 ${
        isCurrent
          ? "border-primary bg-primary/5"
          : "border-border"
      }`}
    >
      <div className="mt-0.5">
        {entry.applied ? (
          <CheckCircle2
            className="h-5 w-5 text-green-500"
            data-testid="migration-applied"
          />
        ) : (
          <Circle
            className="h-5 w-5 text-muted-foreground"
            data-testid="migration-pending"
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">
            {entry.revision}
          </span>
          {isCurrent && (
            <Badge variant="default" data-testid="current-head-badge">
              HEAD
            </Badge>
          )}
          {entry.applied && !isCurrent && (
            <Badge variant="secondary">Applied</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {entry.description}
        </p>
        {entry.down_revision && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Depends on: {entry.down_revision}
          </p>
        )}
      </div>
    </div>
  );
}

export function MigrationsPage({ projectId }: MigrationsPageProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["migrations", projectId],
    queryFn: () => fetchMigrations(projectId),
    enabled: !!projectId,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error ? error.message : "Failed to load migrations"}
        </p>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <GitCommitHorizontal className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Migrations</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Migration History</span>
            {data.current_head && (
              <span className="text-sm font-normal text-muted-foreground">
                Current head:{" "}
                <code className="font-mono">{data.current_head}</code>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.migrations.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No migrations found.
            </p>
          ) : (
            <div className="space-y-2">
              {data.migrations.map((entry) => (
                <MigrationItem
                  key={entry.revision}
                  entry={entry}
                  isCurrent={entry.revision === data.current_head}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
