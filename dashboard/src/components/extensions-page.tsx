import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchExtensions } from "~/lib/introspection";

interface ExtensionsPageProps {
  projectId: string;
  apiKey: string;
}

export function ExtensionsPage({ projectId, apiKey }: ExtensionsPageProps) {
  const {
    data: extensions,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["extensions", projectId, apiKey],
    queryFn: () => fetchExtensions(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="extensions-loading" className="space-y-4">
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
            : "Failed to fetch extensions"}
        </p>
      </div>
    );
  }

  if (!extensions || extensions.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Extensions</h2>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No extensions installed. Install a Postgres extension to see it here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Extensions</h2>
      <div className="space-y-4">
        {extensions.map((ext) => (
          <Card key={ext.name}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="font-mono">{ext.name}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{ext.schema}</Badge>
                  <Badge variant="secondary">{ext.version}</Badge>
                </div>
              </div>
            </CardHeader>
            {ext.comment && (
              <CardContent>
                <p className="text-sm text-muted-foreground">{ext.comment}</p>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
