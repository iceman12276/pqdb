import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Lock,
  Unlock,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Badge } from "~/components/ui/badge";
import { useEncryption } from "~/lib/encryption-context";
import { fetchTableRows, insertRow, deleteRow } from "~/lib/table-data";
import {
  fetchSchema,
  type IntrospectionColumn,
} from "~/lib/schema";
import { deriveSecretKey, decryptValue } from "~/lib/pqc-decrypt";

interface TableDataViewerProps {
  projectId: string;
  tableName: string;
  apiKey: string;
}

const PAGE_SIZE = 25;

export function TableDataViewer({
  projectId,
  tableName,
  apiKey,
}: TableDataViewerProps) {
  const [page, setPage] = React.useState(0);
  const queryClient = useQueryClient();
  const { isUnlocked, encryptionKey, unlock, lock } = useEncryption();
  const [decryptedRows, setDecryptedRows] = React.useState<
    Map<string, Record<string, string>>
  >(new Map());
  const [decrypting, setDecrypting] = React.useState(false);

  const {
    data: rows,
    isLoading: rowsLoading,
    error: rowsError,
  } = useQuery({
    queryKey: ["table-rows", projectId, tableName, apiKey, page],
    queryFn: () =>
      fetchTableRows(tableName, apiKey, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: !!apiKey,
  });

  const { data: schema, isLoading: schemaLoading } = useQuery({
    queryKey: ["schema", projectId, apiKey],
    queryFn: () => fetchSchema(apiKey),
    enabled: !!apiKey,
  });

  const tableSchema = schema?.find((t) => t.name === tableName);
  const columns = React.useMemo(
    () => tableSchema?.columns ?? [],
    [tableSchema],
  );

  // Decrypt rows when key is available
  React.useEffect(() => {
    if (!isUnlocked || !encryptionKey || !rows || !columns.length) {
      setDecryptedRows((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }

    let cancelled = false;
    const encryptedCols = columns.filter(
      (c) => c.sensitivity === "searchable" || c.sensitivity === "private",
    );

    if (encryptedCols.length === 0) return;

    async function runDecryption() {
      setDecrypting(true);
      const secretKey = await deriveSecretKey(encryptionKey!);
      const newMap = new Map<string, Record<string, string>>();

      for (const row of rows!) {
        const rowId = String(row.id ?? "");
        const values: Record<string, string> = {};

        for (const col of encryptedCols) {
          const encValue = row[`${col.name}_encrypted`];
          if (encValue && typeof encValue === "string") {
            const plaintext = await decryptValue(encValue, secretKey);
            if (plaintext !== null) {
              values[col.name] = plaintext;
            } else {
              values[col.name] = "[decrypt error]";
            }
          }
        }

        if (Object.keys(values).length > 0) {
          newMap.set(rowId, values);
        }
      }

      if (!cancelled) {
        setDecryptedRows(newMap);
        setDecrypting(false);
      }
    }

    runDecryption();
    return () => {
      cancelled = true;
    };
  }, [isUnlocked, encryptionKey, rows, columns]);

  const isLoading = rowsLoading || schemaLoading;

  if (isLoading) {
    return (
      <div data-testid="table-data-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (rowsError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {rowsError instanceof Error
            ? rowsError.message
            : "Failed to fetch rows"}
        </p>
      </div>
    );
  }

  function getCellValue(
    row: Record<string, unknown>,
    col: IntrospectionColumn,
  ): React.ReactNode {
    if (col.sensitivity === "plain") {
      const val = row[col.name];
      return val === null || val === undefined ? (
        <span className="text-muted-foreground italic">null</span>
      ) : (
        String(val)
      );
    }

    // Encrypted columns
    if (!isUnlocked) {
      return (
        <span className="text-muted-foreground italic">[encrypted]</span>
      );
    }

    const rowId = String(row.id ?? "");
    const decryptedValue = decryptedRows.get(rowId)?.[col.name];
    if (decryptedValue) {
      return decryptedValue;
    }

    if (decrypting) {
      return (
        <span className="text-muted-foreground italic">decrypting...</span>
      );
    }

    return (
      <span className="text-muted-foreground italic">[encrypted]</span>
    );
  }

  function handleRefresh() {
    queryClient.invalidateQueries({
      queryKey: ["table-rows", projectId, tableName, apiKey],
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{tableName}</h2>
        <div className="flex items-center gap-2">
          <InsertRowDialog
            tableName={tableName}
            columns={columns}
            apiKey={apiKey}
            onSuccess={handleRefresh}
          />
          {isUnlocked ? (
            <Button variant="outline" size="sm" onClick={() => lock()}>
              <Lock className="h-4 w-4 mr-1" />
              Lock
            </Button>
          ) : (
            <UnlockDialog onUnlock={unlock} />
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  {columns.map((col) => (
                    <th
                      key={col.name}
                      className="px-4 py-3 text-left font-medium"
                    >
                      <div className="flex items-center gap-2">
                        {col.name}
                        {col.sensitivity !== "plain" && (
                          <Badge
                            className={`text-[9px] px-1 py-0 ${
                              col.sensitivity === "searchable"
                                ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                                : "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                            }`}
                          >
                            {col.sensitivity}
                          </Badge>
                        )}
                      </div>
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-medium w-20">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows && rows.length > 0 ? (
                  rows.map((row, idx) => (
                    <tr
                      key={String(row.id ?? idx)}
                      className="border-b border-border last:border-0 hover:bg-muted/30"
                    >
                      {columns.map((col) => (
                        <td
                          key={col.name}
                          className="px-4 py-2 font-mono text-xs"
                        >
                          {getCellValue(row, col)}
                        </td>
                      ))}
                      <td className="px-4 py-2 text-right">
                        <DeleteRowButton
                          tableName={tableName}
                          row={row}
                          apiKey={apiKey}
                          onSuccess={handleRefresh}
                        />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={columns.length + 1}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      No rows yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Page {page + 1}
          {rows && rows.length < PAGE_SIZE ? " (last page)" : ""}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={!rows || rows.length < PAGE_SIZE}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function UnlockDialog({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (key.trim()) {
      onUnlock(key.trim());
      setOpen(false);
      setKey("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Unlock className="h-4 w-4 mr-1" />
            Unlock
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decrypt Columns</DialogTitle>
          <DialogDescription>
            Enter your encryption key to decrypt sensitive columns. The key is
            held in memory only and never sent to the server.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="encryption-key">Encryption Key</Label>
            <Input
              id="encryption-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Enter your encryption key"
              autoComplete="off"
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!key.trim()}>
              <Unlock className="h-4 w-4 mr-1" />
              Decrypt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InsertRowDialog({
  tableName,
  columns,
  apiKey,
  onSuccess,
}: {
  tableName: string;
  columns: IntrospectionColumn[];
  apiKey: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Only allow inserting plain columns — encrypted columns need SDK-side encryption
  const insertableColumns = columns.filter((c) => c.sensitivity === "plain");

  function handleReset() {
    setValues({});
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const row: Record<string, unknown> = {};
      for (const col of insertableColumns) {
        const val = values[col.name];
        if (val !== undefined && val !== "") {
          row[col.name] = val;
        }
      }
      await insertRow(tableName, row, apiKey);
      setOpen(false);
      handleReset();
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to insert row");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) handleReset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Insert Row
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Insert Row into {tableName}</DialogTitle>
          <DialogDescription>
            Enter values for plain columns. Encrypted columns must be inserted
            via the SDK.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="space-y-4 max-h-96 overflow-y-auto"
        >
          {insertableColumns.map((col) => (
            <div key={col.name} className="space-y-1">
              <Label htmlFor={`insert-${col.name}`}>{col.name}</Label>
              <Input
                id={`insert-${col.name}`}
                value={values[col.name] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({
                    ...prev,
                    [col.name]: e.target.value,
                  }))
                }
                placeholder={col.type}
              />
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Inserting..." : "Insert"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRowButton({
  tableName,
  row,
  apiKey,
  onSuccess,
}: {
  tableName: string;
  row: Record<string, unknown>;
  apiKey: string;
  onSuccess: () => void;
}) {
  const [deleting, setDeleting] = React.useState(false);

  async function handleDelete() {
    if (!row.id) return;
    setDeleting(true);
    try {
      await deleteRow(
        tableName,
        [{ column: "id", op: "eq", value: String(row.id) }],
        apiKey,
      );
      onSuccess();
    } catch {
      // Error handling — the row may already be deleted
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleDelete}
      disabled={deleting || !row.id}
      className="text-destructive hover:text-destructive"
      aria-label="Delete"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}
