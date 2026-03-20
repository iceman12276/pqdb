import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useProjectContext } from "~/lib/project-context";

interface RealtimeEvent {
  id: string;
  type: string;
  table?: string;
  event?: string;
  row?: Record<string, unknown>;
  timestamp: number;
  raw: Record<string, unknown>;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected";

function eventTypeBadgeVariant(
  eventType: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (eventType) {
    case "INSERT":
      return "default";
    case "UPDATE":
      return "secondary";
    case "DELETE":
      return "destructive";
    default:
      return "outline";
  }
}

function isEncryptedColumn(key: string): boolean {
  return key.endsWith("_encrypted");
}

function formatRowData(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isEncryptedColumn(key)) {
      result[key] = "[encrypted]";
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getWsBaseUrl(): string {
  const loc = typeof window !== "undefined" ? window.location : null;
  if (!loc) return "ws://localhost:8000";
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}`;
}

export function RealtimePage({ projectId }: { projectId: string }) {
  const { apiKey } = useProjectContext();
  const [status, setStatus] = React.useState<ConnectionStatus>("disconnected");
  const [events, setEvents] = React.useState<RealtimeEvent[]>([]);
  const [subscribedTables, setSubscribedTables] = React.useState<string[]>([]);
  const [tableInput, setTableInput] = React.useState("");
  const wsRef = React.useRef<WebSocket | null>(null);
  const eventIdCounter = React.useRef(0);

  const handleConnect = React.useCallback(() => {
    if (!apiKey) return;

    const baseUrl = getWsBaseUrl();
    const wsUrl = `${baseUrl}/v1/realtime?apikey=${encodeURIComponent(apiKey)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setStatus("connecting");

    ws.onopen = () => {
      setStatus("connected");
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as Record<string, unknown>;
        const newEvent: RealtimeEvent = {
          id: `evt-${++eventIdCounter.current}`,
          type: data.type as string,
          table: data.table as string | undefined,
          event: data.event as string | undefined,
          row: data.row as Record<string, unknown> | undefined,
          timestamp: Date.now(),
          raw: data,
        };

        setEvents((prev) => [newEvent, ...prev]);

        // Handle subscription acks
        if (data.type === "ack" && data.action === "subscribe" && data.table) {
          setSubscribedTables((prev) =>
            prev.includes(data.table as string)
              ? prev
              : [...prev, data.table as string],
          );
        }
        if (data.type === "ack" && data.action === "unsubscribe" && data.table) {
          setSubscribedTables((prev) =>
            prev.filter((t) => t !== data.table),
          );
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
    };

    ws.onerror = () => {
      setStatus("disconnected");
    };
  }, [apiKey]);

  const handleDisconnect = React.useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
  }, []);

  const handleSubscribe = React.useCallback(() => {
    if (!tableInput.trim() || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "subscribe", table: tableInput.trim() }));
    setTableInput("");
  }, [tableInput]);

  const handleUnsubscribe = React.useCallback(
    (table: string) => {
      if (!wsRef.current) return;
      wsRef.current.send(JSON.stringify({ type: "unsubscribe", table }));
    },
    [],
  );

  const handleClearEvents = React.useCallback(() => {
    setEvents([]);
  }, []);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return (
    <div className="space-y-6" data-testid="realtime-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Realtime</h1>
        <div className="flex items-center gap-3">
          <Badge
            variant={status === "connected" ? "default" : "outline"}
            data-testid="connection-status"
          >
            {status === "connected"
              ? "Connected"
              : status === "connecting"
                ? "Connecting..."
                : "Disconnected"}
          </Badge>
          {status === "disconnected" ? (
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={!apiKey}
              data-testid="connect-btn"
            >
              Connect
            </Button>
          ) : status === "connected" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={handleDisconnect}
              data-testid="disconnect-btn"
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Connections
            </CardTitle>
          </CardHeader>
          <CardContent data-testid="connections-count">
            <span className="text-2xl font-bold">
              {status === "connected" ? 1 : 0}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Subscriptions
            </CardTitle>
          </CardHeader>
          <CardContent data-testid="subscriptions-count">
            <span className="text-2xl font-bold">{subscribedTables.length}</span>
          </CardContent>
        </Card>
      </div>

      {/* Subscribe to Table */}
      {status === "connected" && (
        <Card>
          <CardHeader>
            <CardTitle>Subscribe to Table</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="Table name"
                value={tableInput}
                onChange={(e) => setTableInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubscribe();
                }}
                data-testid="subscribe-table-input"
              />
              <Button
                size="sm"
                onClick={handleSubscribe}
                disabled={!tableInput.trim()}
                data-testid="subscribe-btn"
              >
                Subscribe
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Subscribed Tables */}
      {subscribedTables.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Subscribed Tables</CardTitle>
          </CardHeader>
          <CardContent data-testid="subscribed-tables">
            <div className="flex flex-wrap gap-2">
              {subscribedTables.map((table) => (
                <Badge key={table} variant="secondary" className="gap-1">
                  {table}
                  <button
                    className="ml-1 text-xs hover:text-destructive"
                    onClick={() => handleUnsubscribe(table)}
                    data-testid={`unsubscribe-${table}`}
                  >
                    x
                  </button>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Event Inspector */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Event Inspector</span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearEvents}
              data-testid="clear-events-btn"
            >
              Clear
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0" data-testid="event-inspector">
          {events.length === 0 ? (
            <div
              className="py-12 text-center text-muted-foreground"
              data-testid="events-empty"
            >
              No realtime events yet. Connect and subscribe to a table to see live events.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="events-table">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Time
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Type
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Table
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Event
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Row ID
                    </th>
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Data
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((evt) => (
                    <EventRow key={evt.id} event={evt} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EventRow({ event }: { event: RealtimeEvent }) {
  const formattedRow = event.row ? formatRowData(event.row) : null;
  const rowId =
    event.row && typeof event.row.id === "string" ? event.row.id : "-";

  return (
    <tr data-testid="event-row" className="border-b border-border">
      <td className="py-2 px-3 text-sm text-muted-foreground whitespace-nowrap">
        {new Date(event.timestamp).toLocaleTimeString()}
      </td>
      <td className="py-2 px-3">
        <Badge variant="outline" className="text-xs">
          {event.type}
        </Badge>
      </td>
      <td className="py-2 px-3 text-sm font-mono">
        {event.table ?? "-"}
      </td>
      <td className="py-2 px-3">
        {event.event ? (
          <Badge
            variant={eventTypeBadgeVariant(event.event)}
            data-testid="event-type-badge"
          >
            {event.event}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </td>
      <td className="py-2 px-3 text-sm font-mono">{rowId}</td>
      <td className="py-2 px-3 text-sm font-mono max-w-xs truncate">
        {formattedRow ? JSON.stringify(formattedRow) : "-"}
      </td>
    </tr>
  );
}
