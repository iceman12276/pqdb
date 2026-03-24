import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw, AlertTriangle, Check, Plus, Trash2, Shield } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Separator } from "~/components/ui/separator";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  fetchProjectKeys,
  rotateProjectKeys,
  createScopedKey,
  deleteProjectKey,
  type ApiKeyInfo,
  type ApiKeyCreated,
  type ScopedKeyCreated,
  type ApiKeyPermissions,
} from "~/lib/projects";
import { fetchTables, type TableListItem } from "~/lib/table-data";

interface ApiKeysPageProps {
  projectId: string;
  apiKey?: string;
}

const OPERATIONS = ["select", "insert", "update", "delete"] as const;

function maskKey(prefix: string): string {
  return `${prefix}****`;
}

function CopyButton({
  text,
  label,
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      aria-label={label ?? "Copy"}
    >
      {copied ? (
        <Check className="h-4 w-4" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </Button>
  );
}

function PermissionBadges({ permissions }: { permissions: ApiKeyPermissions }) {
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {Object.entries(permissions.tables).map(([table, ops]) => (
        <Badge key={table} variant="secondary" className="text-xs">
          {table}: {(ops as string[]).join(", ")}
        </Badge>
      ))}
    </div>
  );
}

function CreateScopedKeyDialog({
  projectId,
  apiKey,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  apiKey: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: ScopedKeyCreated) => void;
}) {
  const [name, setName] = React.useState("");
  const [selectedPerms, setSelectedPerms] = React.useState<
    Record<string, Set<string>>
  >({});

  const { data: tables, isLoading: tablesLoading } = useQuery({
    queryKey: ["tables", projectId, apiKey],
    queryFn: () => fetchTables(apiKey!),
    enabled: open && !!apiKey,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const permissions: ApiKeyPermissions = { tables: {} };
      for (const [table, ops] of Object.entries(selectedPerms)) {
        if (ops.size > 0) {
          permissions.tables[table] = Array.from(ops);
        }
      }
      return createScopedKey(projectId, name, permissions);
    },
    onSuccess: (data) => {
      onCreated(data);
      setName("");
      setSelectedPerms({});
    },
  });

  const togglePerm = (table: string, op: string) => {
    setSelectedPerms((prev) => {
      const next = { ...prev };
      const ops = new Set(prev[table] ?? []);
      if (ops.has(op)) {
        ops.delete(op);
      } else {
        ops.add(op);
      }
      next[table] = ops;
      return next;
    });
  };

  const hasPermissions = Object.values(selectedPerms).some((ops) => ops.size > 0);
  const canCreate = name.trim().length > 0 && hasPermissions;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Create Scoped Key
          </DialogTitle>
          <DialogDescription>
            Create an API key with limited permissions on specific tables.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key-name">Key Name</Label>
            <Input
              id="key-name"
              placeholder="Key name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Table Permissions</Label>
            {tablesLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : tables && tables.length > 0 ? (
              <div className="border rounded-md">
                <div className="grid grid-cols-[1fr_repeat(4,_auto)] gap-x-4 gap-y-0 p-3 border-b bg-muted/50 text-xs font-medium">
                  <span>Table</span>
                  {OPERATIONS.map((op) => (
                    <span key={op} className="text-center capitalize">
                      {op}
                    </span>
                  ))}
                </div>
                {tables.map((table) => (
                  <div
                    key={table.name}
                    className="grid grid-cols-[1fr_repeat(4,_auto)] gap-x-4 gap-y-0 p-3 border-b last:border-b-0 items-center"
                  >
                    <span className="text-sm font-mono">{table.name}</span>
                    {OPERATIONS.map((op) => (
                      <div key={op} className="flex justify-center">
                        <Checkbox
                          data-testid={`perm-${table.name}-${op}`}
                          checked={selectedPerms[table.name]?.has(op) ?? false}
                          onCheckedChange={() => togglePerm(table.name, op)}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No tables found. Create tables first to set permissions.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canCreate || createMutation.isPending}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysPage({ projectId, apiKey }: ApiKeysPageProps) {
  const queryClient = useQueryClient();
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [showNewKeysDialog, setShowNewKeysDialog] = React.useState(false);
  const [showCreateScopedDialog, setShowCreateScopedDialog] = React.useState(false);
  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = React.useState<string | null>(null);
  const [showNewScopedKeyDialog, setShowNewScopedKeyDialog] = React.useState(false);
  const [newKeys, setNewKeys] = React.useState<ApiKeyCreated[]>([]);
  const [newScopedKey, setNewScopedKey] = React.useState<ScopedKeyCreated | null>(null);

  const {
    data: keys,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["projectKeys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
    enabled: !!projectId,
  });

  const rotateMutation = useMutation({
    mutationFn: () => rotateProjectKeys(projectId),
    onSuccess: (data) => {
      setNewKeys(data);
      setShowConfirmDialog(false);
      setShowNewKeysDialog(true);
      queryClient.invalidateQueries({ queryKey: ["projectKeys", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteProjectKey(projectId, keyId),
    onSuccess: () => {
      setShowDeleteConfirmDialog(null);
      queryClient.invalidateQueries({ queryKey: ["projectKeys", projectId] });
    },
  });

  if (isLoading) {
    return (
      <div data-testid="keys-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load API keys</p>
      </div>
    );
  }

  const builtInKeys = keys?.filter((k) => k.role !== "scoped") ?? [];
  const scopedKeys = keys?.filter((k) => k.role === "scoped") ?? [];

  const snippet = `import { createClient } from '@pqdb/client'

const client = createClient('https://localhost', '<your-anon-key>')`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">API Keys</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowCreateScopedDialog(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Scoped Key
          </Button>
          <Button
            variant="destructive"
            onClick={() => setShowConfirmDialog(true)}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Rotate Keys
          </Button>
        </div>
      </div>

      {/* Built-in keys */}
      <div className="space-y-4">
        {builtInKeys.map((key) => (
          <Card key={key.id} className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Badge variant="outline">{key.role}</Badge>
                <Badge variant="secondary">Full access</Badge>
                <code className="text-sm text-muted-foreground">
                  {maskKey(key.key_prefix)}
                </code>
              </div>
              <CopyButton
                text={maskKey(key.key_prefix)}
                label={`Copy ${key.role} key`}
              />
            </div>
          </Card>
        ))}
      </div>

      {/* Scoped keys */}
      {scopedKeys.length > 0 && (
        <>
          <Separator />
          <h3 className="text-lg font-medium">Scoped Keys</h3>
          <div className="space-y-4">
            {scopedKeys.map((key) => (
              <Card key={key.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{key.role}</Badge>
                    <span className="text-sm font-medium">{key.name}</span>
                    <code className="text-sm text-muted-foreground">
                      {maskKey(key.key_prefix)}
                    </code>
                  </div>
                  <div className="flex items-center gap-1">
                    <CopyButton
                      text={maskKey(key.key_prefix)}
                      label={`Copy ${key.role} key`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowDeleteConfirmDialog(key.id)}
                      aria-label="Delete key"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                {key.permissions && (
                  <PermissionBadges permissions={key.permissions} />
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      <Separator />

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-medium">SDK Connection Snippet</h3>
          <Button
            variant="ghost"
            size="sm"
            data-testid="copy-snippet-btn"
            onClick={() => navigator.clipboard.writeText(snippet)}
            aria-label="Copy snippet"
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <pre
          data-testid="sdk-snippet"
          className="rounded-md bg-muted p-4 text-sm overflow-x-auto"
        >
          <code>{snippet}</code>
        </pre>
      </div>

      {/* Create Scoped Key Dialog */}
      <CreateScopedKeyDialog
        projectId={projectId}
        apiKey={apiKey}
        open={showCreateScopedDialog}
        onOpenChange={setShowCreateScopedDialog}
        onCreated={(key) => {
          setShowCreateScopedDialog(false);
          setNewScopedKey(key);
          setShowNewScopedKeyDialog(true);
          queryClient.invalidateQueries({ queryKey: ["projectKeys", projectId] });
        }}
      />

      {/* New Scoped Key One-Time Display Dialog */}
      <Dialog open={showNewScopedKeyDialog} onOpenChange={setShowNewScopedKeyDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Scoped Key Created</DialogTitle>
            <DialogDescription className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              This key is shown only once. Store it securely.
            </DialogDescription>
          </DialogHeader>
          {newScopedKey && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{newScopedKey.name}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all text-sm bg-muted p-2 rounded font-mono select-all">
                  {newScopedKey.key}
                </code>
                <CopyButton text={newScopedKey.key} label="Copy scoped key" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowNewScopedKeyDialog(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={showDeleteConfirmDialog !== null}
        onOpenChange={(open) => {
          if (!open) setShowDeleteConfirmDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Scoped Key
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this scoped key? Any applications
              using it will lose access immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirmDialog(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (showDeleteConfirmDialog) {
                  deleteMutation.mutate(showDeleteConfirmDialog);
                }
              }}
              disabled={deleteMutation.isPending}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotation Confirmation Dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Rotate API Keys
            </DialogTitle>
            <DialogDescription>
              This will invalidate your current API keys. Any applications using
              the old keys will stop working immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => rotateMutation.mutate()}
              disabled={rotateMutation.isPending}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Keys One-Time Display Dialog */}
      <Dialog open={showNewKeysDialog} onOpenChange={setShowNewKeysDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New API Keys</DialogTitle>
            <DialogDescription className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              Keys are shown only once. Store them securely.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {newKeys.map((key) => (
              <div key={key.id} className="space-y-1">
                <Badge variant="outline">{key.role}</Badge>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-sm bg-muted p-2 rounded font-mono select-all">
                    {key.key}
                  </code>
                  <CopyButton text={key.key} label={`Copy ${key.role} key`} />
                </div>
              </div>
            ))}
          </div>
          {(() => {
            const newAnonKey = newKeys.find((k) => k.role === "anon");
            if (!newAnonKey) return null;
            const newSnippet = `import { createClient } from '@pqdb/client'\n\nconst client = createClient(\n  'https://localhost',\n  '${newAnonKey.key}'\n)`;
            return (
              <>
                <Separator />
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium">SDK Connection Snippet</h4>
                    <CopyButton text={newSnippet} label="Copy snippet" />
                  </div>
                  <pre
                    data-testid="new-keys-snippet"
                    className="rounded-md bg-muted p-4 text-sm overflow-x-auto font-mono"
                  >
                    <code>{newSnippet}</code>
                  </pre>
                </div>
              </>
            );
          })()}
          <DialogFooter>
            <Button onClick={() => setShowNewKeysDialog(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
