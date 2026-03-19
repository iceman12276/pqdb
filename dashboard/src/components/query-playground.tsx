/**
 * QueryPlayground — main component for building and executing queries.
 *
 * Combines QueryBuilder, QueryResults, query history, and
 * the Unlock toggle (EncryptionContext) into a single page.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Unlock, Clock } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { QueryBuilder, type QueryBuilderState } from "~/components/query-builder";
import { QueryResults } from "~/components/query-results";
import { fetchSchema, type IntrospectionTable } from "~/lib/schema";
import {
  buildQueryPayload,
  executeQuery,
  type QueryResult,
} from "~/lib/query";
import {
  EncryptionProvider,
  useEncryption,
} from "~/lib/encryption-context";

interface QueryPlaygroundProps {
  projectId: string;
  apiKey: string;
}

interface HistoryEntry {
  table: string;
  payload: string;
  timestamp: Date;
  rowCount: number | null;
  error: string | null;
}

function QueryPlaygroundInner({ projectId, apiKey }: QueryPlaygroundProps) {
  const { isUnlocked, unlock, lock } = useEncryption();
  const [keyInput, setKeyInput] = React.useState("");

  const {
    data: tables,
    isLoading,
    error: schemaError,
  } = useQuery({
    queryKey: ["schema", projectId, apiKey],
    queryFn: () => fetchSchema(apiKey),
    enabled: !!apiKey,
  });

  const [builderState, setBuilderState] = React.useState<QueryBuilderState>({
    table: "",
    columns: [],
    filters: [],
    limit: "",
    offset: "",
    orderBy: "",
    orderDir: "asc",
  });

  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [isExecuting, setIsExecuting] = React.useState(false);
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);

  const selectedTable = tables?.find((t) => t.name === builderState.table);

  async function handleExecute() {
    if (!builderState.table) return;
    setIsExecuting(true);
    setResult(null);

    const payload = buildQueryPayload({
      table: builderState.table,
      columns: builderState.columns,
      filters: builderState.filters,
      limit: builderState.limit ? Number(builderState.limit) : undefined,
      offset: builderState.offset ? Number(builderState.offset) : undefined,
      orderBy: builderState.orderBy || undefined,
      orderDir: builderState.orderDir || undefined,
    });

    const queryResult = await executeQuery(builderState.table, payload, apiKey);
    setResult(queryResult);
    setIsExecuting(false);

    // Add to history
    setHistory((prev) => [
      {
        table: builderState.table,
        payload: JSON.stringify(payload, null, 2),
        timestamp: new Date(),
        rowCount: queryResult.data?.length ?? null,
        error: queryResult.error ?? null,
      },
      ...prev,
    ]);
  }

  function handleReplay(entry: HistoryEntry) {
    // Re-parse the payload and set builder state
    try {
      const payload = JSON.parse(entry.payload);
      setBuilderState({
        table: entry.table,
        columns: payload.columns[0] === "*" ? [] : payload.columns,
        filters: payload.filters ?? [],
        limit: payload.modifiers?.limit?.toString() ?? "",
        offset: payload.modifiers?.offset?.toString() ?? "",
        orderBy: payload.modifiers?.order_by ?? "",
        orderDir: payload.modifiers?.order_dir ?? "asc",
      });
    } catch {
      // Ignore parse errors
    }
  }

  function handleUnlockToggle() {
    if (isUnlocked) {
      lock();
      setKeyInput("");
    } else if (keyInput.trim()) {
      unlock(keyInput.trim());
    }
  }

  if (isLoading) {
    return (
      <div data-testid="query-playground-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (schemaError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {schemaError instanceof Error
            ? schemaError.message
            : "Failed to fetch schema"}
        </p>
      </div>
    );
  }

  if (!tables || tables.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          No tables yet. Create a table using the SDK or API to start querying.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Query Playground</h2>
        <div className="flex items-center gap-2">
          {!isUnlocked && (
            <Input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Encryption key..."
              type="password"
              className="w-48"
              data-testid="encryption-key-input"
            />
          )}
          <Button
            variant={isUnlocked ? "default" : "outline"}
            size="sm"
            onClick={handleUnlockToggle}
            disabled={!isUnlocked && !keyInput.trim()}
            data-testid="unlock-toggle"
          >
            {isUnlocked ? (
              <>
                <Unlock className="mr-1 h-3.5 w-3.5" />
                Lock
              </>
            ) : (
              <>
                <Lock className="mr-1 h-3.5 w-3.5" />
                Unlock
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Query Builder */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Query Builder</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryBuilder
            tables={tables}
            state={builderState}
            onChange={setBuilderState}
            onExecute={handleExecute}
            isExecuting={isExecuting}
          />
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Results</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryResults
            data={result?.data ?? null}
            error={result?.error ?? null}
            columns={selectedTable?.columns ?? []}
            isExecuting={isExecuting}
          />
        </CardContent>
      </Card>

      {/* Query History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Query History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div data-testid="query-history">
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No queries yet</p>
            ) : (
              <div className="space-y-2">
                {history.map((entry, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-lg border p-3"
                    data-testid={`history-entry-${idx}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">
                          {entry.table}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {entry.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {entry.error ? (
                          <span className="text-destructive">{entry.error}</span>
                        ) : (
                          `${entry.rowCount ?? 0} rows returned`
                        )}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReplay(entry)}
                    >
                      Replay
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function QueryPlayground(props: QueryPlaygroundProps) {
  return (
    <EncryptionProvider>
      <QueryPlaygroundInner {...props} />
    </EncryptionProvider>
  );
}
