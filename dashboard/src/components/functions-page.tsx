import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { FunctionSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchFunctions, type CatalogFunction } from "~/lib/introspection";

interface FunctionsPageProps {
  projectId: string;
  apiKey: string;
}

export function FunctionsPage({ projectId, apiKey }: FunctionsPageProps) {
  const {
    data: functions,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["catalog-functions", projectId, apiKey],
    queryFn: () => fetchFunctions(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="functions-loading" className="space-y-4">
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
          {error instanceof Error ? error.message : "Failed to fetch functions"}
        </p>
      </div>
    );
  }

  if (!functions || functions.length === 0) {
    return (
      <div className="text-center py-12">
        <FunctionSquare className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">
          No functions found. Create functions using SQL to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Functions</h2>
      <div className="space-y-4">
        {functions.map((fn) => (
          <FunctionCard key={`${fn.schema}.${fn.name}`} fn={fn} />
        ))}
      </div>
    </div>
  );
}

function FunctionCard({ fn }: { fn: CatalogFunction }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 font-mono text-base">
            <FunctionSquare className="h-4 w-4" />
            {fn.name}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{fn.language}</Badge>
            <Badge variant="outline">{fn.return_type}</Badge>
          </div>
        </div>
        {fn.args && (
          <p className="text-sm text-muted-foreground font-mono mt-1">
            {fn.args}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <pre
          data-testid="function-source"
          className="rounded-md bg-muted p-4 text-sm font-mono overflow-x-auto whitespace-pre-wrap"
        >
          {fn.source}
        </pre>
      </CardContent>
    </Card>
  );
}
