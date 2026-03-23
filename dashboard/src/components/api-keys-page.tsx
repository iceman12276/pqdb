import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw, AlertTriangle, Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Separator } from "~/components/ui/separator";
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
  type ApiKeyInfo,
  type ApiKeyCreated,
} from "~/lib/projects";

interface ApiKeysPageProps {
  projectId: string;
}

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

export function ApiKeysPage({ projectId }: ApiKeysPageProps) {
  const queryClient = useQueryClient();
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [showNewKeysDialog, setShowNewKeysDialog] = React.useState(false);
  const [newKeys, setNewKeys] = React.useState<ApiKeyCreated[]>([]);

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

  const anonKey = keys?.find((k) => k.role === "anon");

  const snippet = `import { createClient } from '@pqdb/client'

const client = createClient('https://localhost', '<your-anon-key>')`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">API Keys</h2>
        <Button
          variant="destructive"
          onClick={() => setShowConfirmDialog(true)}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Rotate Keys
        </Button>
      </div>

      <div className="space-y-4">
        {keys?.map((key) => (
          <Card key={key.id} className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Badge variant="outline">{key.role}</Badge>
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

      {/* Confirmation Dialog */}
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
