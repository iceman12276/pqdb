import * as React from "react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { generateKeyPair } from "@pqdb/client";
import { saveKeypair, deleteKeypair } from "~/lib/keypair-store";
import { getAccessToken } from "~/lib/auth-store";

interface RecoverKeypairModalProps {
  developerId: string;
  onReload: () => void;
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type Mode = "choose" | "upload" | "regenerate";

/**
 * Recovery modal shown when keypair-context reports error='missing'.
 * Offers two paths: upload a recovery file or generate a new keypair.
 */
export function RecoverKeypairModal({
  developerId,
  onReload,
}: RecoverKeypairModalProps) {
  const [mode, setMode] = React.useState<Mode>("choose");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);

  async function handleFileUpload(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setLoading(true);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.public_key || !data.private_key) {
        setError("Invalid recovery file format.");
        setLoading(false);
        return;
      }

      const filePublicKey = fromBase64(data.public_key);
      const fileSecretKey = fromBase64(data.private_key);

      // Fetch the server's stored public key to validate match
      const token = getAccessToken();
      const resp = await fetch("/v1/auth/me/public-key", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!resp.ok) {
        setError("Failed to verify public key with server.");
        setLoading(false);
        return;
      }

      const serverData = await resp.json();
      if (!serverData.public_key) {
        setError("No public key stored on server.");
        setLoading(false);
        return;
      }

      const serverPublicKey = fromBase64(serverData.public_key);

      if (!arraysEqual(filePublicKey, serverPublicKey)) {
        setError("This recovery file does not match your account.");
        setLoading(false);
        return;
      }

      // Match confirmed — save to IndexedDB
      await saveKeypair(developerId, {
        publicKey: filePublicKey,
        secretKey: fileSecretKey,
      });

      onReload();
    } catch {
      setError("Failed to parse recovery file.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerate() {
    setError(null);
    setLoading(true);

    try {
      const keypair = await generateKeyPair();

      const token = getAccessToken();
      const resp = await fetch("/v1/auth/me/public-key", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          public_key: toBase64(keypair.publicKey),
        }),
      });

      if (!resp.ok) {
        setError("Failed to upload new public key to server.");
        setLoading(false);
        return;
      }

      // Clear old keypair and save new one
      await deleteKeypair(developerId);
      await saveKeypair(developerId, {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
      });

      onReload();
    } catch {
      setError("Failed to generate new keypair.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recover-keypair-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg">
        <h2
          id="recover-keypair-title"
          className="text-xl font-semibold"
        >
          Keypair Recovery
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your encryption keypair was not found in this browser. Choose
          how to restore access to your encrypted data.
        </p>

        {error && (
          <p className="mt-3 text-sm text-red-500" role="alert">
            {error}
          </p>
        )}

        {mode === "choose" && (
          <div className="mt-6 flex flex-col gap-3">
            <Button
              type="button"
              onClick={() => setMode("upload")}
              className="w-full"
            >
              Upload recovery file
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMode("regenerate")}
              className="w-full"
            >
              Generate new keypair
            </Button>
          </div>
        )}

        {mode === "upload" && (
          <div className="mt-6 flex flex-col gap-3">
            <Label htmlFor="recovery-file-input" className="text-sm">
              Select your recovery file (.json)
            </Label>
            <input
              id="recovery-file-input"
              data-testid="recovery-file-input"
              type="file"
              accept=".json,application/json"
              onChange={handleFileUpload}
              disabled={loading}
              className="text-sm"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setMode("choose");
                setError(null);
              }}
              disabled={loading}
            >
              Back
            </Button>
          </div>
        )}

        {mode === "regenerate" && (
          <div className="mt-6 flex flex-col gap-3">
            <p className="text-sm font-medium text-red-500">
              All projects created before this moment will become
              unrecoverable. This cannot be undone.
            </p>
            <div className="flex items-start gap-2">
              <input
                id="regenerate-ack"
                type="checkbox"
                role="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1"
              />
              <Label
                htmlFor="regenerate-ack"
                className="text-sm font-normal leading-tight"
              >
                I understand
              </Label>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setMode("choose");
                  setError(null);
                  setAcknowledged(false);
                }}
                disabled={loading}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleRegenerate}
                disabled={!acknowledged || loading}
              >
                Confirm
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
