import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "~/lib/theme";
import { EnvelopeKeyProvider } from "~/lib/envelope-key-context";
import { SidebarNav } from "~/components/sidebar-nav";
import { TopBar } from "~/components/top-bar";
import appCss from "~/styles/app.css?url";

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
          <EnvelopeKeyProvider>
            <ThemeProvider>
              {isAuthRoute ? (
                <Outlet />
              ) : (
                <div data-testid="dashboard-layout" className="flex h-screen">
                  <SidebarNav />
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <TopBar />
                    <main className="flex-1 overflow-auto p-6">
                      <Outlet />
                    </main>
                  </div>
                </div>
              )}
            </ThemeProvider>
          </EnvelopeKeyProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
