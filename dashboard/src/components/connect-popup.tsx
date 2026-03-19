import * as React from "react";
import { Skeleton } from "~/components/ui/skeleton";
import { Separator } from "~/components/ui/separator";
import { Badge } from "~/components/ui/badge";
import { fetchProjectKeys, type ApiKeyInfo } from "~/lib/projects";

interface ConnectPopupProps {
  projectId: string | null;
  projectName: string | null;
}

export function ConnectPopup({ projectId, projectName }: ConnectPopupProps) {
  const [keys, setKeys] = React.useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetchProjectKeys(projectId)
      .then((data) => {
        setKeys(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [projectId]);

  if (!projectId) {
    return (
      <div className="text-sm text-muted-foreground p-2">
        Select a project first
      </div>
    );
  }

  if (loading) {
    return (
      <div data-testid="connect-loading" className="space-y-2 p-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  const anonKey = keys.find((k) => k.role === "anon");
  const serviceKey = keys.find((k) => k.role === "service_role");

  const snippet = `import { createClient } from '@pqdb/client'

const client = createClient({
  url: '${window.location.origin}',
  apiKey: '${anonKey?.key_prefix ?? "your-anon-key"}...',
})`;

  return (
    <div className="space-y-3 p-1">
      <div>
        <h4 className="text-sm font-medium mb-2">
          API Keys — {projectName}
        </h4>
        <div className="space-y-2">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between gap-2"
            >
              <Badge variant="outline">{key.role}</Badge>
              <code className="text-xs text-muted-foreground">
                {key.key_prefix}...
              </code>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      <div>
        <h4 className="text-sm font-medium mb-2">Quick Start</h4>
        <pre className="rounded-md bg-muted p-2 text-xs overflow-x-auto">
          <code>{snippet}</code>
        </pre>
      </div>
    </div>
  );
}
