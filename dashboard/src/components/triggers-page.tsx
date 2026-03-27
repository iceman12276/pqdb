import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchTriggers, type CatalogTrigger } from "~/lib/introspection";

interface TriggersPageProps {
  projectId: string;
  apiKey: string;
}

const timingColors: Record<string, string> = {
  BEFORE: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  AFTER: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "INSTEAD OF":
    "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

export function TriggersPage({ projectId, apiKey }: TriggersPageProps) {
  const {
    data: triggers,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["catalog-triggers", projectId, apiKey],
    queryFn: () => fetchTriggers(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="triggers-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error ? error.message : "Failed to fetch triggers"}
        </p>
      </div>
    );
  }

  if (!triggers || triggers.length === 0) {
    return (
      <div className="text-center py-12">
        <Zap className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">
          No triggers found. Create triggers using SQL to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Triggers</h2>
      <div className="space-y-4">
        {triggers.map((trigger) => (
          <TriggerCard
            key={`${trigger.table}.${trigger.name}`}
            trigger={trigger}
          />
        ))}
      </div>
    </div>
  );
}

function TriggerCard({ trigger }: { trigger: CatalogTrigger }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 font-mono text-base">
            <Zap className="h-4 w-4" />
            {trigger.name}
          </CardTitle>
          <Badge className={timingColors[trigger.timing] ?? ""}>
            {trigger.timing}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Table: </span>
            <span className="font-mono font-medium">{trigger.table}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Function: </span>
            <span className="font-mono font-medium">
              {trigger.function_name}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Events:</span>
          {trigger.events.map((event) => (
            <Badge key={event} variant="outline">
              {event}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
