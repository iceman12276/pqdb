import * as React from "react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";

export interface RecoveryKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

interface RecoveryFileModalProps {
  developerId: string;
  email: string;
  keypair: RecoveryKeyPair;
  onClose: () => void;
}

const RECOVERY_WARNING =
  "This is your ML-KEM-768 keypair. If you lose it, your encrypted project " +
  "data CANNOT be decrypted — there is no recovery on the server. Keep this " +
  "file somewhere safe and never share it.";

function toBase64(bytes: Uint8Array): string {
  // JSDOM + modern browsers both support btoa + fromCharCode for small
  // payloads. ML-KEM-768 secret keys are ~2.4 KB which is well within
  // argument-length limits of fromCharCode.apply.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Post-signup modal that shows the developer their recovery file and
 * forces them to either download it OR explicitly acknowledge the risk
 * of losing their private key before dismissing.
 *
 * The private key has ALREADY been persisted to IndexedDB by the caller —
 * this modal is purely about giving the user an offline backup path.
 */
export function RecoveryFileModal({
  developerId,
  email,
  keypair,
  onClose,
}: RecoveryFileModalProps) {
  const [downloaded, setDownloaded] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);

  const canClose = downloaded || acknowledged;

  function handleDownload() {
    const payload = {
      version: 1,
      developer_id: developerId,
      email,
      public_key: toBase64(keypair.publicKey),
      private_key: toBase64(keypair.secretKey),
      created_at: new Date().toISOString(),
      warning: RECOVERY_WARNING,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pqdb-recovery-${email}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg">
        <h2
          id="recovery-modal-title"
          className="text-xl font-semibold"
        >
          Save your recovery file
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We generated an ML-KEM-768 keypair for your account. The private
          key lives only in this browser. Download the recovery file and
          keep it somewhere safe — without it, you will not be able to
          decrypt your project data from another device.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <Button type="button" onClick={handleDownload} className="w-full">
            Download recovery file
          </Button>

          <div className="flex items-start gap-2 pt-2">
            <input
              id="recovery-ack"
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1"
            />
            <Label
              htmlFor="recovery-ack"
              className="text-sm font-normal leading-tight"
            >
              I understand — I will not be able to decrypt my data if I
              lose this key.
            </Label>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={!canClose}
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
