import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useProjectContext } from "~/lib/project-context";
import { fetchIndexes, type IndexInfo } from "~/lib/introspection";

/** Extract the index method (btree, hash, gin, etc.) from the CREATE INDEX definition. */
function extractIndexType(definition: string): string {
  const match = /USING\s+(\w+)/i.exec(definition);
  return match ? match[1] : "unknown";
}

/** Extract the column list from the parenthesized expression after USING method (...). */
function extractColumns(definition: string): string {
  const match = /USING\s+\w+\s+\((.+)\)\s*$/i.exec(definition);
  return match ? match[1].trim() : "";
}

/** Format bytes to human-readable size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function IndexesPage({ projectId }: { projectId: string }) {
  const { apiKey } = useProjectContext();

  const { data: indexes, isLoading, error } = useQuery({
    queryKey: ["indexes", projectId],
    queryFn: () => fetchIndexes(apiKey!),
    enabled: !!apiKey,
  });

  return (
    <div className="space-y-6" data-testid="indexes-page">
      <h1 className="text-2xl font-bold">Indexes</h1>

      {isLoading && (
        <div className="space-y-3" data-testid="indexes-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {error && (
        <div
          className="text-center py-12 text-destructive"
          data-testid="indexes-error"
        >
          Failed to load indexes.
        </div>
      )}

      {indexes && indexes.length === 0 && (
        <div
          className="text-center py-12 text-muted-foreground"
          data-testid="indexes-empty"
        >
          No indexes found in this database.
        </div>
      )}

      {indexes && indexes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="indexes-table">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Name
                </th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Table
                </th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Columns
                </th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Type
                </th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Unique
                </th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx) => (
                <IndexRow key={idx.name} index={idx} />
              ))}
            </tbody>
          </table>

          <div className="mt-6 space-y-3">
            {indexes.map((idx) => (
              <Card key={`def-${idx.name}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-mono">{idx.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <code className="text-xs text-muted-foreground break-all">
                    {idx.definition}
                  </code>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IndexRow({ index }: { index: IndexInfo }) {
  const indexType = extractIndexType(index.definition);
  const columns = extractColumns(index.definition);

  return (
    <tr className="border-b border-border" data-testid="index-row">
      <td className="py-2 px-3 text-sm font-mono font-medium">
        {index.name}
      </td>
      <td className="py-2 px-3 text-sm font-mono">{index.table}</td>
      <td className="py-2 px-3 text-sm font-mono">{columns}</td>
      <td className="py-2 px-3 text-sm">{indexType}</td>
      <td className="py-2 px-3">
        {index.unique && (
          <Badge variant="secondary">Unique</Badge>
        )}
      </td>
      <td className="py-2 px-3 text-sm text-muted-foreground">
        {formatSize(index.size_bytes)}
      </td>
    </tr>
  );
}
