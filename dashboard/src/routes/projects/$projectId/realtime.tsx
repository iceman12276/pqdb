import { createFileRoute } from "@tanstack/react-router";
import { RealtimePage } from "~/components/realtime-page";

export const Route = createFileRoute("/projects/$projectId/realtime")({
  component: RealtimeRoute,
});

function RealtimeRoute() {
  const { projectId } = Route.useParams();
  return <RealtimePage projectId={projectId} />;
}
