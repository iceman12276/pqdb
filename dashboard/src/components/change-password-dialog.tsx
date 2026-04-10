import * as React from "react";
import { api } from "~/lib/api-client";
import { setTokens } from "~/lib/auth-store";
import { deriveWrappingKey, unwrapKey, wrapKey } from "~/lib/envelope-crypto";
import { useEnvelopeKeys } from "~/lib/keypair-context";
import { fetchProjects } from "~/lib/projects";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: ChangePasswordDialogProps) {
  const { setWrappingKey } = useEnvelopeKeys();
  const [email, setEmail] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  function resetForm() {
    setEmail("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email || !currentPassword || !newPassword || !confirmPassword) {
      setError("All fields are required");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword === currentPassword) {
      setError("New password must be different from current password");
      return;
    }

    setLoading(true);
    try {
      // Step 1: Call change-password API
      const result = await api.fetch("/v1/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      if (!result.ok) {
        const errorData = result.data as {
          error?: { message?: string };
          detail?: string;
        } | null;
        setError(
          errorData?.error?.message ??
            errorData?.detail ??
            "Failed to change password",
        );
        return;
      }

      const tokens = result.data as {
        access_token: string;
        refresh_token: string;
      };

      // Step 2: Derive old and new wrapping keys
      const [oldWrappingKey, newWrappingKeyVal] = await Promise.all([
        deriveWrappingKey(currentPassword, email),
        deriveWrappingKey(newPassword, email),
      ]);

      // Step 3: Re-wrap all project encryption keys
      const projects = await fetchProjects();
      let failedCount = 0;

      for (const project of projects) {
        if (!project.wrapped_encryption_key) continue;

        try {
          const wrappedBlob = base64ToUint8Array(
            project.wrapped_encryption_key,
          );
          const plaintextKey = await unwrapKey(wrappedBlob, oldWrappingKey);
          const newWrappedBlob = await wrapKey(plaintextKey, newWrappingKeyVal);
          const newWrappedBase64 = uint8ArrayToBase64(newWrappedBlob);

          const patchResult = await api.fetch(
            `/v1/projects/${project.id}/encryption-key`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                wrapped_encryption_key: newWrappedBase64,
              }),
            },
          );

          if (!patchResult.ok) {
            console.warn(
              "Failed to re-wrap key for project",
              project.id,
              patchResult.status,
            );
            failedCount++;
          }
        } catch (err) {
          console.warn(
            "Failed to re-wrap key for project",
            project.id,
            err,
          );
          failedCount++;
        }
      }

      // Step 4: Update wrapping key in context
      setWrappingKey(newWrappingKeyVal);

      // Step 5: Save new tokens
      setTokens(
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        },
        { persist: true },
      );

      if (failedCount > 0) {
        console.warn(
          `Password changed but ${failedCount} project(s) failed to re-wrap`,
        );
      }

      resetForm();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>
            Your encryption keys will be re-wrapped with the new password.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cp-email">Email</Label>
            <Input
              id="cp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              autoComplete="email"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cp-current-password">Current Password</Label>
            <Input
              id="cp-current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cp-new-password">New Password</Label>
            <Input
              id="cp-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cp-confirm-password">Confirm New Password</Label>
            <Input
              id="cp-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Changing..." : "Change Password"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
