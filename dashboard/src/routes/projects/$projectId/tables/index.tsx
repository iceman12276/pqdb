import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { AuthGuard } from "~/components/auth-guard";
import { TableListPage } from "~/components/table-list-page";
import { Skeleton } from "~/components/ui/skeleton";
import { EncryptionProvider, useEncryption } from "~/lib/encryption-context";
import { useEnvelopeKeys } from "~/lib/envelope-key-context";
import { ProjectProvider, useProjectContext } from "~/lib/project-context";

export const Route = createFileRoute("/projects/$projectId/tables/")({
  component: TablesRoute,
});

function TablesRoute() {
  const { projectId } = Route.useParams();

  return (
    <AuthGuard>
      <ProjectProvider projectId={projectId}>
        <TablesRouteInner projectId={projectId} />
      </ProjectProvider>
    </AuthGuard>
  );
}

function TablesRouteInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
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
          No API key found. Create an API key to view tables.
        </p>
      </div>
    );
  }

  return (
    <EncryptionProvider>
      <AutoUnlock projectId={projectId} />
      <TableListPage
        projectId={projectId}
        apiKey={apiKey}
        onSelectTable={(name) => {
          navigate({
            to: "/projects/$projectId/tables/$tableName",
            params: { projectId, tableName: name },
          });
        }}
      />
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
