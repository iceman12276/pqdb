import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { fetchReplication } from "~/lib/introspection";

interface ReplicationPageProps {
  projectId: string;
  apiKey: string;
}

export function ReplicationPage({ projectId, apiKey }: ReplicationPageProps) {
  const {
    data: replication,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["replication", projectId, apiKey],
    queryFn: () => fetchReplication(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="replication-loading" className="space-y-4">
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
            : "Failed to fetch replication status"}
        </p>
      </div>
    );
  }

  const hasSlots = replication && replication.slots.length > 0;
  const hasStats = replication && replication.stats.length > 0;
  const isEmpty = !hasSlots && !hasStats;

  if (isEmpty) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Replication</h2>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No replication configured.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Replication</h2>

      {hasSlots && (
        <Card>
          <CardHeader>
            <CardTitle>Replication Slots</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Slot Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Restart LSN</TableHead>
                  <TableHead>Confirmed Flush LSN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {replication.slots.map((slot) => (
                  <TableRow key={slot.slot_name}>
                    <TableCell className="font-mono">{slot.slot_name}</TableCell>
                    <TableCell>{slot.slot_type}</TableCell>
                    <TableCell>
                      <Badge variant={slot.active ? "default" : "secondary"}>
                        {slot.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono">
                      {slot.restart_lsn ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {slot.confirmed_flush_lsn ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {hasStats && (
        <Card>
          <CardHeader>
            <CardTitle>Active Replication Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client Address</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Sent LSN</TableHead>
                  <TableHead>Write LSN</TableHead>
                  <TableHead>Replay LSN</TableHead>
                  <TableHead>Replay Lag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {replication.stats.map((stat, idx) => (
                  <TableRow key={stat.client_addr ?? idx}>
                    <TableCell className="font-mono">
                      {stat.client_addr ?? "-"}
                    </TableCell>
                    <TableCell>{stat.state}</TableCell>
                    <TableCell className="font-mono">
                      {stat.sent_lsn ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {stat.write_lsn ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {stat.replay_lsn ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {stat.replay_lag ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
