import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { ChevronLeft } from "lucide-react";
import { AuthGuard } from "~/components/auth-guard";
import { TableDataViewer } from "~/components/table-data-viewer";
import { Skeleton } from "~/components/ui/skeleton";
import { EncryptionProvider, useEncryption } from "~/lib/encryption-context";
import { useEnvelopeKeys } from "~/lib/keypair-context";
import { ProjectProvider, useProjectContext } from "~/lib/project-context";

export const Route = createFileRoute(
  "/projects/$projectId/tables/$tableName",
)({
  component: TableDetailRoute,
});

function TableDetailRoute() {
  const { projectId, tableName } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectProvider projectId={projectId}>
        <TableDetailRouteInner projectId={projectId} tableName={tableName} />
      </ProjectProvider>
    </AuthGuard>
  );
}

function TableDetailRouteInner({
  projectId,
  tableName,
}: {
  projectId: string;
  tableName: string;
}) {
  const { project, apiKey, loading, error } = useProjectContext();

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">{error ?? "Project not found"}</p>
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          No API key found. Create an API key to view table data.
        </p>
      </div>
    );
  }

  return (
    <EncryptionProvider>
      <AutoUnlock projectId={projectId} />
      <div className="space-y-4">
        <Link
          to="/projects/$projectId/tables"
          params={{ projectId }}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Tables
        </Link>
        <TableDataViewer
          projectId={projectId}
          tableName={tableName}
          apiKey={apiKey}
        />
      </div>
    </EncryptionProvider>
  );
}

function AutoUnlock({ projectId }: { projectId: string }) {
  const { getEncryptionKey } = useEnvelopeKeys();
  const { unlock, isUnlocked } = useEncryption();

  React.useEffect(() => {
    const key = getEncryptionKey(projectId);
    if (key && !isUnlocked) {
      unlock(key);
    }
  }, [projectId, getEncryptionKey, unlock, isUnlocked]);

  return null;
}
