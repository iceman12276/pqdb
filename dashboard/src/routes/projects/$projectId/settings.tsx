import { createFileRoute } from "@tanstack/react-router";
import { EncryptionSettings } from "~/components/encryption-settings";
import { RevealEncryptionKey } from "~/components/reveal-encryption-key";
import { PauseSettings } from "~/components/pause-settings";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const { projectId } = Route.useParams();
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Project Settings</h1>
      <PauseSettings projectId={projectId} />
      <RevealEncryptionKey projectId={projectId} />
      <EncryptionSettings />
    </div>
  );
}
