/**
 * ProjectDecapsulateGate — triggers PQC decapsulation for the current project
 * and renders informational banners for error/missing-key states.
 *
 * Always renders children — banners are informational, not blocking.
 */

import * as React from "react";
import { useProjectDecapsulate } from "./use-project-decapsulate";

interface Props {
  projectId: string;
  wrappedEncryptionKey: string | null;
  children: React.ReactNode;
}

export function ProjectDecapsulateGate({
  projectId,
  wrappedEncryptionKey,
  children,
}: Props) {
  const { status, error } = useProjectDecapsulate(
    projectId,
    wrappedEncryptionKey,
  );

  return (
    <>
      {status === "no-key" && (
        <div
          role="status"
          className="rounded-md border border-blue-500/50 bg-blue-50 dark:bg-blue-950/30 p-3 text-sm text-blue-800 dark:text-blue-200 mb-4"
        >
          This project has no encryption key configured. Sensitive columns will
          be unavailable.
        </div>
      )}
      {(status === "error" || status === "no-keypair") && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive mb-4"
        >
          {error ??
            "Could not decrypt this project. You may need to upload a different recovery file."}
        </div>
      )}
      {children}
    </>
  );
}
