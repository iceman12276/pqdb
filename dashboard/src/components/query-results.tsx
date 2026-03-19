/**
 * QueryResults — displays query results in a table format.
 *
 * Encrypted columns show [encrypted] unless the EncryptionContext is unlocked.
 */

import * as React from "react";
import type { IntrospectionColumn } from "~/lib/schema";
import { useEncryption } from "~/lib/encryption-context";

interface QueryResultsProps {
  data: Record<string, unknown>[] | null;
  error: string | null;
  columns: IntrospectionColumn[];
  isExecuting: boolean;
}

export function QueryResults({
  data,
  error,
  columns,
  isExecuting,
}: QueryResultsProps) {
  const { isUnlocked } = useEncryption();

  if (isExecuting) {
    return (
      <div
        data-testid="query-results-loading"
        className="py-8 text-center text-muted-foreground"
      >
        Executing query...
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="query-results-error" className="py-4">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm font-medium text-destructive">Query Error</p>
          <p className="mt-1 text-sm text-destructive/80">{error}</p>
        </div>
      </div>
    );
  }

  if (data === null) {
    return (
      <div
        data-testid="query-results-empty"
        className="py-8 text-center text-muted-foreground"
      >
        Execute a query to see results
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div
        data-testid="query-results-no-rows"
        className="py-8 text-center text-muted-foreground"
      >
        Query returned 0 rows
      </div>
    );
  }

  // Build a sensitivity lookup from column metadata
  const sensitivityMap = new Map<string, string>();
  for (const col of columns) {
    if (col.sensitivity === "searchable") {
      sensitivityMap.set(`${col.name}_encrypted`, "encrypted");
      sensitivityMap.set(`${col.name}_index`, "index");
    } else if (col.sensitivity === "private") {
      sensitivityMap.set(`${col.name}_encrypted`, "encrypted");
    }
  }

  const resultKeys = Object.keys(data[0]);

  function formatCell(key: string, value: unknown): string {
    const sens = sensitivityMap.get(key);
    if (sens === "encrypted" && !isUnlocked) {
      return "[encrypted]";
    }
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  return (
    <div data-testid="query-results" className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {data.length} row{data.length !== 1 ? "s" : ""} returned
      </p>
      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {resultKeys.map((key) => (
                <th
                  key={key}
                  className="px-3 py-2 text-left font-medium text-muted-foreground"
                >
                  {key}
                  {sensitivityMap.has(key) && (
                    <span className="ml-1 text-xs opacity-60">
                      ({sensitivityMap.get(key)})
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="border-b last:border-0 hover:bg-muted/30"
              >
                {resultKeys.map((key) => (
                  <td
                    key={key}
                    className={`px-3 py-2 font-mono text-xs ${
                      sensitivityMap.get(key) === "encrypted" && !isUnlocked
                        ? "text-muted-foreground italic"
                        : ""
                    }`}
                  >
                    {formatCell(key, row[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
