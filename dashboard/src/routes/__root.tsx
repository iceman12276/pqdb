import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { ThemeProvider } from "~/lib/theme";
import { SidebarNav } from "~/components/sidebar-nav";
import { TopBar } from "~/components/top-bar";
import appCss from "~/styles/app.css?url";

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
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider>
          <div data-testid="dashboard-layout" className="flex h-screen">
            <SidebarNav />
            <div className="flex flex-1 flex-col overflow-hidden">
              <TopBar />
              <main className="flex-1 overflow-auto p-6">
                <Outlet />
              </main>
            </div>
          </div>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
