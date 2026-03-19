import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { AuthGuard } from "~/components/auth-guard";
import { TableDataViewer } from "~/components/table-data-viewer";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  fetchProject,
  fetchProjectKeys,
  type Project,
  type ApiKeyInfo,
} from "~/lib/projects";
import { EncryptionProvider } from "~/lib/encryption-context";

export const Route = createFileRoute(
  "/projects/$projectId/tables/$tableName",
)({
  component: TableDetailRoute,
});

function TableDetailRoute() {
  const { projectId, tableName } = Route.useParams();
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
            No API key found. Create an API key to view table data.
          </p>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <EncryptionProvider>
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
    </AuthGuard>
  );
}
