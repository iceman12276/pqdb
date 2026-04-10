import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "~/lib/theme";
import {
  KeypairProvider,
  useKeypair,
  developerIdFromToken,
} from "~/lib/keypair-context";
import { getAccessToken } from "~/lib/auth-store";
import { SidebarNav } from "~/components/sidebar-nav";
import { TopBar } from "~/components/top-bar";
import { RecoverKeypairModal } from "~/components/recover-keypair-modal";
import appCss from "~/styles/app.css?url";

function KeypairRecovery() {
  const { error, reload } = useKeypair();
  if (error !== "missing") return null;

  const token = getAccessToken();
  const developerId = token ? developerIdFromToken(token) : null;
  if (!developerId) return null;

  return <RecoverKeypairModal developerId={developerId} onReload={reload} />;
}

const AUTH_ROUTES = ["/login", "/signup"];

const queryClient = new QueryClient();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "pqdb Dashboard" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const isAuthRoute = AUTH_ROUTES.includes(pathname);

  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <KeypairProvider>
            <ThemeProvider>
              {isAuthRoute ? (
                <Outlet />
              ) : (
                <div data-testid="dashboard-layout" className="flex h-screen">
                  <SidebarNav />
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <TopBar />
                    <KeypairRecovery />
                    <main className="flex-1 overflow-auto p-6">
                      <Outlet />
                    </main>
                  </div>
                </div>
              )}
            </ThemeProvider>
          </KeypairProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
