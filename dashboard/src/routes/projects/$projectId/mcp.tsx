import { createFileRoute } from "@tanstack/react-router";
import { McpPage } from "~/components/mcp-page";

export const Route = createFileRoute("/projects/$projectId/mcp")({
  component: McpRoute,
});

function McpRoute() {
  const { projectId } = Route.useParams();
  return <McpPage projectId={projectId} />;
}
