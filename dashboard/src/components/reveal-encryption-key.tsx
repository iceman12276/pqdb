import * as React from "react";
import { Eye, EyeOff, Copy, Check, AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useEnvelopeKeys } from "~/lib/keypair-context";

interface RevealEncryptionKeyProps {
  projectId: string;
}

export function RevealEncryptionKey({ projectId }: RevealEncryptionKeyProps) {
  const { getEncryptionKey } = useEnvelopeKeys();
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const encryptionKey = getEncryptionKey(projectId);

  const handleCopy = async () => {
    if (!encryptionKey) return;
    await navigator.clipboard.writeText(encryptionKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Encryption Key</CardTitle>
        <CardDescription>
          Your project encryption key for use with the SDK.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {encryptionKey === null ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Encryption key not available. Log in with your password to access
              your encryption key, or use the SDK&apos;s{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                encryptionKey
              </code>{" "}
              option.
            </p>
          </div>
        ) : (
          <>
            {revealed ? (
              <div className="flex gap-2">
                <Input
                  value={encryptionKey}
                  readOnly
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  aria-label={copied ? "Copied" : "Copy"}
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevealed(false)}
                  aria-label="Hide"
                >
                  <EyeOff className="h-4 w-4" />
                  Hide
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => setRevealed(true)}
                aria-label="Reveal"
              >
                <Eye className="h-4 w-4" />
                Reveal
              </Button>
            )}

            <div className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">
                Your encryption key is never stored by pqdb. If you lose this
                key, your encrypted data is permanently unrecoverable. Store it
                securely.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
