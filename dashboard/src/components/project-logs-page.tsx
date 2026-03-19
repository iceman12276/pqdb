import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  fetchProjectLogs,
  type AuditLogEntry,
  type AuditLogResponse,
  type LogFilters,
} from "~/lib/project-overview";

const PAGE_SIZE = 20;

function statusBadgeVariant(
  code: number,
): "default" | "secondary" | "destructive" | "outline" {
  if (code >= 200 && code < 300) return "default";
  if (code >= 400 && code < 500) return "outline";
  if (code >= 500) return "destructive";
  return "secondary";
}

function LogRow({ entry }: { entry: AuditLogEntry }) {
  return (
    <tr data-testid="log-row" className="border-b border-border">
      <td className="py-2 px-3 text-sm text-muted-foreground whitespace-nowrap">
        {entry.created_at
          ? new Date(entry.created_at).toLocaleString()
          : "N/A"}
      </td>
      <td className="py-2 px-3">
        <Badge variant="secondary" data-testid="log-event-type">
          {entry.event_type}
        </Badge>
      </td>
      <td className="py-2 px-3 text-sm font-mono">
        <span className="font-semibold">{entry.method}</span>{" "}
        <span className="text-muted-foreground">{entry.path}</span>
      </td>
      <td className="py-2 px-3">
        <Badge variant={statusBadgeVariant(entry.status_code)} data-testid="log-status-code">
          {entry.status_code}
        </Badge>
      </td>
      <td className="py-2 px-3 text-sm text-muted-foreground font-mono">
        {entry.ip_address}
      </td>
    </tr>
  );
}

export function ProjectLogsPage({ projectId }: { projectId: string }) {
  const [eventType, setEventType] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [page, setPage] = React.useState(0);

  const filters: LogFilters = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    event_type: eventType !== "all" ? eventType : undefined,
    status_code:
      statusFilter !== "all" ? parseInt(statusFilter, 10) : undefined,
  };

  const {
    data: logs,
    isLoading,
    error,
  } = useQuery<AuditLogResponse>({
    queryKey: ["project-logs", projectId, filters],
    queryFn: () => fetchProjectLogs(projectId, filters),
  });

  const totalPages = logs ? Math.ceil(logs.total / PAGE_SIZE) : 0;

  if (error) {
    return (
      <div className="text-center py-12" data-testid="logs-error">
        <p className="text-destructive">Failed to load audit logs</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="project-logs">
      <h1 className="text-2xl font-bold">Audit Logs</h1>

      {/* Filters */}
      <div className="flex gap-4" data-testid="log-filters">
        <div className="w-48">
          <Select value={eventType} onValueChange={(v) => { if (v) { setEventType(v); setPage(0); } }}>
            <SelectTrigger data-testid="filter-event-type">
              <SelectValue placeholder="Event Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="database">Database</SelectItem>
              <SelectItem value="auth">Auth</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <Select value={statusFilter} onValueChange={(v) => { if (v) { setStatusFilter(v); setPage(0); } }}>
            <SelectTrigger data-testid="filter-status-code">
              <SelectValue placeholder="Status Code" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="200">200 OK</SelectItem>
              <SelectItem value="201">201 Created</SelectItem>
              <SelectItem value="400">400 Bad Request</SelectItem>
              <SelectItem value="401">401 Unauthorized</SelectItem>
              <SelectItem value="403">403 Forbidden</SelectItem>
              <SelectItem value="404">404 Not Found</SelectItem>
              <SelectItem value="500">500 Server Error</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Log Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Request Log</span>
            {logs && (
              <span className="text-sm font-normal text-muted-foreground" data-testid="log-total">
                {logs.total} total entries
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4" data-testid="logs-loading">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : logs && logs.data.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="log-table">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Time
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Type
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Request
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Status
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      IP
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logs.data.map((entry) => (
                    <LogRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center text-muted-foreground" data-testid="logs-empty">
              No audit log entries found
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between" data-testid="log-pagination">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            data-testid="prev-page"
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            data-testid="next-page"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
