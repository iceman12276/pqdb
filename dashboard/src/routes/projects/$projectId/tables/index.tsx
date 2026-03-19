import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { TableListPage } from "~/components/table-list-page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  fetchProject,
  fetchProjectKeys,
  type Project,
  type ApiKeyInfo,
} from "~/lib/projects";
import { EncryptionProvider } from "~/lib/encryption-context";

export const Route = createFileRoute("/projects/$projectId/tables/")({
  component: TablesRoute,
});

function TablesRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [project, setProject] = React.useState<Project | null>(null);
  const [apiKey, setApiKey] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    async function load() {
      try {
        const [proj, keys] = await Promise.all([
          fetchProject(projectId),
          fetchProjectKeys(projectId),
        ]);
        setProject(proj);
        const serviceKey = keys.find(
          (k: ApiKeyInfo) => k.role === "service_role",
        );
        const anonKey = keys.find((k: ApiKeyInfo) => k.role === "anon");
        const key = serviceKey ?? anonKey;
        if (key) {
          setApiKey(key.key_prefix);
        }
      } catch {
        // error shown via fallback
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [projectId]);

  if (loading) {
    return (
      <AuthGuard>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AuthGuard>
    );
  }

  if (!project) {
    return (
      <AuthGuard>
        <div className="text-center py-12">
          <p className="text-destructive">Project not found</p>
        </div>
      </AuthGuard>
    );
  }

  if (!apiKey) {
    return (
      <AuthGuard>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No API key found. Create an API key to view tables.
          </p>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <EncryptionProvider>
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
    </AuthGuard>
  );
}
