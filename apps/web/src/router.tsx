import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { ContactFilters } from "./api/queries";
import { sessionQuery } from "./api/queries";
import { AppShell } from "./components/app-shell";
import { RouteProgress } from "./components/route-progress";
import { Toaster } from "./components/ui/toast";
import { AuditLogPage } from "./features/audit/audit-log-page";
import { CampaignPage, NewCampaignPage } from "./features/campaigns/campaign-page";
import { CampaignsPage } from "./features/campaigns/campaigns-page";
import { ContactDetailPage } from "./features/contacts/contact-detail";
import { ContactsPage } from "./features/contacts/contacts-page";
import { FieldsPage } from "./features/contacts/fields-page";
import { ListsPage, TagsPage } from "./features/contacts/lists-tags";
import { SuppressionsPage } from "./features/contacts/suppressions-page";
import { TemplatesPage } from "./features/editor/templates-page";
import { ImportPage } from "./features/import/import-page";
import { ConnectionsPage } from "./features/providers/connections-page";
import { DomainDetailPage, DomainsPage } from "./features/providers/domains-page";
import { UsagePage } from "./features/usage/usage-page";
import { LoginPage } from "./routes/login";
import { OverviewPage } from "./routes/overview";
import { RecoverPage } from "./routes/recover";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";

// Code-based routes. Signed-out pages sit at the root. Every other page sits under
// the app layout, which sends a visitor without a session to /login.

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: function Root() {
    return (
      <>
        <RouteProgress />
        <Outlet />
        <Toaster />
      </>
    );
  },
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
const newCampaignRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns/new",
  component: NewCampaignPage,
});
const campaignRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns/$campaignId",
  component: function Campaign() {
    const { campaignId } = campaignRoute.useParams();
    return <CampaignPage key={campaignId} campaignId={Number(campaignId)} />;
  },
});
function positiveId(value: unknown): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

const STATUSES = new Set(["subscribed", "unsubscribed", "suppressed"]);

// Contact filters live in the URL, so a list or a tag can link to its members.
const contactsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts",
  validateSearch: (search: Record<string, unknown>): ContactFilters => ({
    ...(typeof search.search === "string" && search.search ? { search: search.search } : {}),
    ...(positiveId(search.listId) ? { listId: positiveId(search.listId) } : {}),
    ...(positiveId(search.tagId) ? { tagId: positiveId(search.tagId) } : {}),
    ...(typeof search.status === "string" && STATUSES.has(search.status)
      ? { status: search.status as ContactFilters["status"] }
      : {}),
  }),
  component: function Contacts() {
    const filters = contactsRoute.useSearch();
    const navigate = contactsRoute.useNavigate();
    return (
      <ContactsPage
        filters={filters}
        onFiltersChange={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
const contactRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts/$contactId",
  component: function Contact() {
    const { contactId } = contactRoute.useParams();
    return <ContactDetailPage key={contactId} contactId={Number(contactId)} />;
  },
});
const importRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts/import",
  validateSearch: (search: Record<string, unknown>): { id?: number } =>
    positiveId(search.id) ? { id: positiveId(search.id) } : {},
  component: function Import() {
    const { id } = importRoute.useSearch();
    // No key: the page keeps the upload sample in state when the URL gets the import id.
    return <ImportPage importId={id} />;
  },
});
const listsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts/lists",
  component: ListsPage,
});
const tagsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts/tags",
  component: TagsPage,
});
const fieldsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts/fields",
  component: FieldsPage,
});
const suppressionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contacts/suppressions",
  component: SuppressionsPage,
});
const templatesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/templates",
  component: TemplatesPage,
});
// The editor is a lazy chunk: Tiptap and React Email load only when it opens.
const templateRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/templates/$templateId",
  component: lazyRouteComponent(() => import("./features/editor/editor-page"), "EditorRoute"),
});
const connectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connections",
  component: ConnectionsPage,
});
const domainsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connections/domains",
  component: DomainsPage,
});
const domainRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connections/domains/$domainId",
  component: function Domain() {
    const { domainId } = domainRoute.useParams();
    return <DomainDetailPage key={domainId} domainId={Number(domainId)} />;
  },
});
const usageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/usage",
  component: UsagePage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

const auditLogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/audit-log",
  component: AuditLogPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  recoverRoute,
  appRoute.addChildren([
    overviewRoute,
    campaignsRoute,
    newCampaignRoute,
    campaignRoute,
    contactsRoute,
    contactRoute,
    importRoute,
    listsRoute,
    tagsRoute,
    fieldsRoute,
    suppressionsRoute,
    templatesRoute,
    templateRoute,
    connectionsRoute,
    domainsRoute,
    domainRoute,
    usageRoute,
    settingsRoute,
    auditLogRoute,
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
