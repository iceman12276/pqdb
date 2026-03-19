import { createFileRoute } from "@tanstack/react-router";
import { EncryptionSettings } from "~/components/encryption-settings";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Project Settings</h1>
      <EncryptionSettings />
    </div>
  );
}
