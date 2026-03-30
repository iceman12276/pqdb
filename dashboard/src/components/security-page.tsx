import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  fetchSecurityFindings,
  type SecurityFinding,
} from "~/lib/advisor";

interface SecurityPageProps {
  projectId: string;
  apiKey: string;
}

const severityOrder: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function severityVariant(
  severity: string,
): "destructive" | "secondary" | "outline" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "secondary";
  return "outline";
}

function groupBySeverity(
  findings: SecurityFinding[],
): { severity: string; items: SecurityFinding[] }[] {
  const groups = new Map<string, SecurityFinding[]>();
  for (const f of findings) {
    const list = groups.get(f.severity) ?? [];
    list.push(f);
    groups.set(f.severity, list);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (severityOrder[a] ?? 99) - (severityOrder[b] ?? 99))
    .map(([severity, items]) => ({ severity, items }));
}

function countBySeverity(
  findings: SecurityFinding[],
): { critical: number; warning: number; info: number } {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (f.severity in counts) {
      counts[f.severity as keyof typeof counts]++;
    }
  }
  return counts;
}

export function SecurityPage({ projectId, apiKey }: SecurityPageProps) {
  const {
    data: findings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["security-findings", projectId, apiKey],
    queryFn: () => fetchSecurityFindings(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="security-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-full" />
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
            : "Failed to fetch security findings"}
        </p>
      </div>
    );
  }

  if (!findings || findings.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Security</h2>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No security issues found. Your project looks good!
          </p>
        </div>
      </div>
    );
  }

  const groups = groupBySeverity(findings);
  const counts = countBySeverity(findings);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Security</h2>

      <div
        data-testid="summary-bar"
        className="flex items-center gap-4 rounded-lg border border-border bg-muted/50 px-4 py-3"
      >
        <div data-testid="summary-critical" className="flex items-center gap-2">
          <Badge variant="destructive">critical</Badge>
          <span className="text-sm font-medium">{counts.critical}</span>
        </div>
        <div data-testid="summary-warning" className="flex items-center gap-2">
          <Badge variant="secondary">warning</Badge>
          <span className="text-sm font-medium">{counts.warning}</span>
        </div>
        <div data-testid="summary-info" className="flex items-center gap-2">
          <Badge variant="outline">info</Badge>
          <span className="text-sm font-medium">{counts.info}</span>
        </div>
      </div>

      {groups.map((group) => (
        <div
          key={group.severity}
          data-testid={`severity-group-${group.severity}`}
          className="space-y-4"
        >
          <h3 className="text-lg font-medium capitalize">{group.severity}</h3>
          {group.items.map((finding) => (
            <Card key={`${finding.rule_id}-${finding.table ?? "global"}`}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{finding.title}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={severityVariant(finding.severity)}>
                      {finding.severity}
                    </Badge>
                    {finding.table && (
                      <Badge variant="outline">{finding.table}</Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {finding.message}
                </p>
                {finding.suggestion && (
                  <div className="rounded-md bg-muted p-3">
                    <p className="text-sm font-mono">{finding.suggestion}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}
