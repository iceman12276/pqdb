import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";
import { SettingsPage } from "~/components/settings-page";

export const Route = createFileRoute("/settings/")({
  component: SettingsRoute,
});

function SettingsRoute() {
  return (
    <AuthGuard>
      <SettingsPage />
    </AuthGuard>
  );
}
