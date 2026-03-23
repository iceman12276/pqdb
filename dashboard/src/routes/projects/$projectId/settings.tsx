import { createFileRoute } from "@tanstack/react-router";
import { EncryptionSettings } from "~/components/encryption-settings";
import { RevealEncryptionKey } from "~/components/reveal-encryption-key";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const { projectId } = Route.useParams();
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Project Settings</h1>
      <RevealEncryptionKey projectId={projectId} />
      <EncryptionSettings />
    </div>
  );
}
