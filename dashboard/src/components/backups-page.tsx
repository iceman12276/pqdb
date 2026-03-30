import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchBackupStats } from "~/lib/introspection";

interface BackupsPageProps {
  projectId: string;
  apiKey: string;
}

export function BackupsPage({ projectId, apiKey }: BackupsPageProps) {
  const {
    data: stats,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["backups", projectId, apiKey],
    queryFn: () => fetchBackupStats(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="backups-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error
            ? error.message
            : "Failed to fetch backup stats"}
        </p>
      </div>
    );
  }

  const isArchivingConfigured =
    stats &&
    (stats.archived_count > 0 ||
      stats.failed_count > 0 ||
      stats.last_archived_wal !== null ||
      stats.last_failed_wal !== null);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Backups</h2>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Backup management is handled by your database provider (RDS, local
          pg_dump, etc.)
        </AlertDescription>
      </Alert>

      {!isArchivingConfigured ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            WAL archiving is not configured.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Archived WAL Files</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.archived_count}</p>
              {stats.last_archived_wal && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Last: <span className="font-mono">{stats.last_archived_wal}</span>
                </p>
              )}
              {stats.last_archived_time && (
                <p className="text-sm text-muted-foreground">
                  At: {stats.last_archived_time}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Failed Archival Attempts</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.failed_count}</p>
              {stats.last_failed_wal && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Last: <span className="font-mono">{stats.last_failed_wal}</span>
                </p>
              )}
              {stats.last_failed_time && (
                <p className="text-sm text-muted-foreground">
                  At: {stats.last_failed_time}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
