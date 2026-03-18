import { createFileRoute } from "@tanstack/react-router";
import { AuthGuard } from "~/components/auth-guard";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <AuthGuard>
      <div>
        <h1 className="text-2xl font-bold">Welcome to pqdb Dashboard</h1>
        <p className="mt-2 text-muted-foreground">
          Select a project to get started.
        </p>
      </div>
    </AuthGuard>
  );
}
