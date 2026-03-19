import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { QueryPlayground } from "~/components/query-playground";
import { Skeleton } from "~/components/ui/skeleton";
import {
  fetchProject,
  fetchProjectKeys,
  type Project,
  type ApiKeyInfo,
} from "~/lib/projects";

export const Route = createFileRoute("/projects/$projectId/sql")({
  component: SqlRoute,
});

function SqlRoute() {
  const { projectId } = Route.useParams();
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
        // error handled by showing fallback
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
            No API key found. Create an API key to use the Query Playground.
          </p>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <QueryPlayground projectId={projectId} apiKey={apiKey} />
    </AuthGuard>
  );
}
