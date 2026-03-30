import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  fetchPerformanceFindings,
  type PerformanceFinding,
} from "~/lib/advisor";

interface PerformancePageProps {
  projectId: string;
  apiKey: string;
}

const severityOrder: Record<string, number> = { warning: 0, info: 1 };

function severityVariant(
  severity: string,
): "destructive" | "secondary" | "outline" {
  if (severity === "warning") return "destructive";
  return "secondary";
}

function groupBySeverity(
  findings: PerformanceFinding[],
): { severity: string; items: PerformanceFinding[] }[] {
  const groups = new Map<string, PerformanceFinding[]>();
  for (const f of findings) {
    const list = groups.get(f.severity) ?? [];
    list.push(f);
    groups.set(f.severity, list);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (severityOrder[a] ?? 99) - (severityOrder[b] ?? 99))
    .map(([severity, items]) => ({ severity, items }));
}

export function PerformancePage({ projectId, apiKey }: PerformancePageProps) {
  const {
    data: findings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["performance-findings", projectId, apiKey],
    queryFn: () => fetchPerformanceFindings(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="performance-loading" className="space-y-4">
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
            : "Failed to fetch performance findings"}
        </p>
      </div>
    );
  }

  if (!findings || findings.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Performance</h2>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No performance issues found.
          </p>
        </div>
      </div>
    );
  }

  const groups = groupBySeverity(findings);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Performance</h2>
      {groups.map((group) => (
        <div
          key={group.severity}
          data-testid={`severity-group-${group.severity}`}
          className="space-y-4"
        >
          <h3 className="text-lg font-medium capitalize">{group.severity}</h3>
          {group.items.map((finding) => (
            <Card key={`${finding.rule_id}-${finding.table}`}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{finding.title}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={severityVariant(finding.severity)}>
                      {finding.severity}
                    </Badge>
                    <Badge variant="outline">{finding.table}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {finding.message}
                </p>
                <div className="rounded-md bg-muted p-3">
                  <p className="text-sm font-mono">{finding.suggestion}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}
