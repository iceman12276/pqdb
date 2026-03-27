import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useProjectContext } from "~/lib/project-context";
import { fetchPublications, type PublicationInfo } from "~/lib/introspection";

export function PublicationsPage({ projectId }: { projectId: string }) {
  const { apiKey } = useProjectContext();

  const { data: publications, isLoading, error } = useQuery({
    queryKey: ["publications", projectId],
    queryFn: () => fetchPublications(apiKey!),
    enabled: !!apiKey,
  });

  return (
    <div className="space-y-6" data-testid="publications-page">
      <h1 className="text-2xl font-bold">Publications</h1>

      {isLoading && (
        <div className="space-y-3" data-testid="publications-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {error && (
        <div
          className="text-center py-12 text-destructive"
          data-testid="publications-error"
        >
          Failed to load publications.
        </div>
      )}

      {publications && publications.length === 0 && (
        <div
          className="text-center py-12 text-muted-foreground"
          data-testid="publications-empty"
        >
          No publications found in this database.
        </div>
      )}

      {publications && publications.length > 0 && (
        <div className="space-y-4">
          {publications.map((pub) => (
            <PublicationCard key={pub.name} publication={pub} />
          ))}
        </div>
      )}
    </div>
  );
}

function PublicationCard({ publication }: { publication: PublicationInfo }) {
  const enabledOps: string[] = [];
  if (publication.insert) enabledOps.push("INSERT");
  if (publication.update) enabledOps.push("UPDATE");
  if (publication.delete) enabledOps.push("DELETE");

  return (
    <Card data-testid="publication-card">
      <CardHeader>
        <CardTitle className="font-mono">{publication.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Tables:</span>
          {publication.all_tables ? (
            <Badge variant="default">ALL TABLES</Badge>
          ) : publication.tables.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {publication.tables.map((t) => (
                <Badge key={t} variant="outline" className="font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Operations:</span>
          <div className="flex flex-wrap gap-1">
            {enabledOps.map((op) => (
              <Badge key={op} variant="secondary">
                {op}
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
