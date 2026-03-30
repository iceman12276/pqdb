import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Plus, Trash2 } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
  type Webhook,
} from "~/lib/webhooks";
import { fetchTables } from "~/lib/table-data";

interface WebhooksPageProps {
  projectId: string;
  apiKey: string;
}

const EVENTS = ["INSERT", "UPDATE", "DELETE"] as const;

export function WebhooksPage({ projectId, apiKey }: WebhooksPageProps) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Webhook | null>(null);

  const {
    data: webhooks,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["webhooks", projectId, apiKey],
    queryFn: () => fetchWebhooks(apiKey),
    enabled: !!apiKey,
  });

  const { data: tables } = useQuery({
    queryKey: ["tables", projectId, apiKey],
    queryFn: () => fetchTables(apiKey),
    enabled: !!apiKey,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteWebhook(apiKey, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", projectId] });
      setDeleteTarget(null);
    },
  });

  if (isLoading) {
    return (
      <div data-testid="webhooks-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-full" />
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
            : "Failed to fetch webhooks"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Webhooks</h2>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Webhook
        </Button>
      </div>

      {!webhooks || webhooks.length === 0 ? (
        <div className="text-center py-12">
          <Bell className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            No webhooks configured. Add a webhook to receive HTTP notifications
            on row changes.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {webhooks.map((webhook) => (
            <Card key={webhook.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{webhook.table_name}</CardTitle>
                  <div className="flex items-center gap-2">
                    {webhook.events.map((event) => (
                      <Badge key={event} variant="secondary">
                        {event}
                      </Badge>
                    ))}
                    <Badge
                      variant={webhook.active ? "default" : "outline"}
                    >
                      {webhook.active ? "Active" : "Inactive"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Delete"
                      onClick={() => setDeleteTarget(webhook)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground font-mono">
                  {webhook.url}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AddWebhookDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        apiKey={apiKey}
        projectId={projectId}
        tables={tables ?? []}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the webhook for{" "}
              <strong>{deleteTarget?.table_name}</strong> targeting{" "}
              <strong>{deleteTarget?.url}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate(deleteTarget.id);
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddWebhookDialog({
  open,
  onOpenChange,
  apiKey,
  projectId,
  tables,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: string;
  projectId: string;
  tables: { name: string }[];
}) {
  const queryClient = useQueryClient();
  const [tableName, setTableName] = React.useState("");
  const [events, setEvents] = React.useState<Set<string>>(new Set());
  const [url, setUrl] = React.useState("");
  const [secret, setSecret] = React.useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      createWebhook(apiKey, {
        table_name: tableName,
        events: Array.from(events),
        url,
        secret: secret || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", projectId] });
      onOpenChange(false);
      setTableName("");
      setEvents(new Set());
      setUrl("");
      setSecret("");
    },
  });

  const canSubmit = tableName && events.size > 0 && url;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Webhook</DialogTitle>
          <DialogDescription>
            Configure a webhook to receive HTTP notifications when rows change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Table</Label>
            <Select value={tableName} onValueChange={(v) => setTableName(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a table..." />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Events</Label>
            <div className="flex items-center gap-4">
              {EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={events.has(event)}
                    onCheckedChange={(checked) => {
                      const next = new Set(events);
                      if (checked) {
                        next.add(event);
                      } else {
                        next.delete(event);
                      }
                      setEvents(next);
                    }}
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="webhook-url">URL</Label>
            <Input
              id="webhook-url"
              placeholder="https://example.com/webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="webhook-secret">Secret (optional)</Label>
            <Input
              id="webhook-secret"
              placeholder="Optional shared secret for HMAC signing"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
