import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { sessionQuery } from "./api/queries";
import { AppShell } from "./components/app-shell";
import { LoginPage } from "./routes/login";
import { OverviewPage } from "./routes/overview";
import { CampaignsPage, ConnectionsPage, ContactsPage, TemplatesPage } from "./routes/placeholders";
import { RecoverPage } from "./routes/recover";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";

// Code-based routes. Signed-out pages sit at the root. Every other page sits under
// the app layout, which sends a visitor without a session to /login.

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  async beforeLoad({ context }) {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (session) throw redirect({ to: "/" });
  },
  component: function Login() {
    const { redirect: target } = loginRoute.useSearch();
    return <LoginPage redirect={target} />;
  },
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const recoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recover",
  component: RecoverPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  async beforeLoad({ context, location }) {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session) {
      throw redirect({
        to: "/login",
        search: location.href === "/" ? {} : { redirect: location.href },
      });
    }
  },
  component: AppShell,
});

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: OverviewPage,
});
const campaignsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns",
  component: CampaignsPage,
});
const contactsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts",
  component: ContactsPage,
});
const templatesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/templates",
  component: TemplatesPage,
});
const connectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connections",
  component: ConnectionsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  recoverRoute,
  appRoute.addChildren([
    overviewRoute,
    campaignsRoute,
    contactsRoute,
    templatesRoute,
    connectionsRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
