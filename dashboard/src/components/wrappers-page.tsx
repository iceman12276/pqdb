import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchWrappers } from "~/lib/introspection";

interface WrappersPageProps {
  projectId: string;
  apiKey: string;
}

export function WrappersPage({ projectId, apiKey }: WrappersPageProps) {
  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["wrappers", projectId, apiKey],
    queryFn: () => fetchWrappers(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="wrappers-loading" className="space-y-4">
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
            : "Failed to fetch wrappers"}
        </p>
      </div>
    );
  }

  const isEmpty =
    !data ||
    (data.wrappers.length === 0 &&
      data.servers.length === 0 &&
      data.tables.length === 0);

  if (isEmpty) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Foreign Data Wrappers</h2>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No foreign data wrappers configured.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Foreign Data Wrappers</h2>

      {/* Wrappers section */}
      {data.wrappers.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Wrappers</h3>
          <div className="space-y-3">
            {data.wrappers.map((wrapper) => (
              <Card key={wrapper.name}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="font-mono">{wrapper.name}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 text-sm text-muted-foreground">
                    <span>
                      Handler:{" "}
                      <code className="text-foreground">
                        {wrapper.handler ?? "none"}
                      </code>
                    </span>
                    <span>
                      Validator:{" "}
                      <code className="text-foreground">
                        {wrapper.validator ?? "none"}
                      </code>
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Servers section */}
      {data.servers.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Foreign Servers</h3>
          <div className="space-y-3">
            {data.servers.map((server) => (
              <Card key={server.name}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="font-mono">{server.name}</CardTitle>
                    <Badge variant="outline">{server.wrapper}</Badge>
                  </div>
                </CardHeader>
                {server.options.length > 0 && (
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {server.options.map((opt) => (
                        <Badge key={opt} variant="secondary">
                          {opt}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Tables section */}
      {data.tables.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Foreign Tables</h3>
          <div className="space-y-3">
            {data.tables.map((table) => (
              <Card key={`${table.schema}.${table.name}`}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="font-mono">{table.name}</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{table.schema}</Badge>
                      <Badge variant="secondary">{table.server}</Badge>
                    </div>
                  </div>
                </CardHeader>
                {table.columns.length > 0 && (
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {table.columns.map((col) => (
                        <Badge key={col.name} variant="outline">
                          {col.name}: {col.type}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
