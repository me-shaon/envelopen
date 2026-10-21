import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getLoginMode, getSession } from "@/auth/auth-client";
import { api, unwrap } from "./client";

// Query definitions. Keys of workspace data start with ["ws", id], so data of one
// workspace never shows in another. The switcher also invalidates every query.

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: getSession,
  staleTime: 60_000,
});

export const loginModeQuery = queryOptions({
  queryKey: ["login-mode"],
  queryFn: getLoginMode,
  staleTime: Number.POSITIVE_INFINITY,
});

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: () => unwrap(api.GET("/workspaces")),
});

/** The current workspace with its tracking and retention settings. */
export function workspaceSettingsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "settings"],
    queryFn: () => unwrap(api.GET("/workspace")),
  });
}

/**
 * The deployment settings, such as the source link (KTD16). They apply to every
 * workspace, so the key has no workspace id.
 */
export const deploymentSettingsQuery = queryOptions({
  queryKey: ["deployment-settings"],
  queryFn: () => unwrap(api.GET("/settings")),
  staleTime: 5 * 60_000,
});

export function onboardingQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "onboarding"],
    queryFn: () => unwrap(api.GET("/onboarding")),
  });
}

export function apiKeysQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "api-keys"],
    queryFn: () => unwrap(api.GET("/api-keys", { params: { query: { limit: 100 } } })),
  });
}

export const apiKeyPresetsQuery = queryOptions({
  queryKey: ["api-key-presets"],
  queryFn: () => unwrap(api.GET("/api-keys/presets")),
  staleTime: Number.POSITIVE_INFINITY,
});

// Audit log (U17) ------------------------------------------------------------------------

export interface AuditFilters {
  surface?: "ui" | "rest" | "mcp" | "system" | undefined;
  action?: string | undefined;
}

export function auditLogQuery(workspaceId: number, filters: AuditFilters) {
  return infiniteQueryOptions({
    queryKey: ["ws", workspaceId, "audit-log", filters],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/audit-log", {
          params: {
            query: {
              limit: 50,
              ...(filters.surface ? { surface: filters.surface } : {}),
              ...(filters.action ? { action: filters.action } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function auditActionsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "audit-log", "actions"],
    queryFn: () => unwrap(api.GET("/audit-log/actions")),
  });
}

// Contacts (U6) ------------------------------------------------------------------------

export interface ContactFilters {
  search?: string | undefined;
  listId?: number | undefined;
  tagId?: number | undefined;
  status?: "subscribed" | "unsubscribed" | "suppressed" | undefined;
}

/** Drops empty filters, so equal filters share one cache entry. */
function cleanFilters(filters: ContactFilters): ContactFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
  ) as ContactFilters;
}

export function contactsQuery(workspaceId: number, filters: ContactFilters) {
  const query = cleanFilters(filters);
  return infiniteQueryOptions({
    queryKey: ["ws", workspaceId, "contacts", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/contacts", {
          params: { query: { ...query, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function contactCountsQuery(workspaceId: number, filters: ContactFilters) {
  const query = cleanFilters(filters);
  return queryOptions({
    queryKey: ["ws", workspaceId, "contacts", "count", query],
    queryFn: () => unwrap(api.GET("/contacts/count", { params: { query } })),
  });
}

export function contactQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "contacts", "one", id],
    queryFn: () => unwrap(api.GET("/contacts/{id}", { params: { path: { id } } })),
  });
}

export function consentQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "contacts", "consent", id],
    queryFn: () =>
      unwrap(
        api.GET("/contacts/{id}/consent", { params: { path: { id }, query: { limit: 100 } } }),
      ),
  });
}

export function listsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "lists"],
    queryFn: () => unwrap(api.GET("/lists", { params: { query: { limit: 100 } } })),
  });
}

export function tagsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "tags"],
    queryFn: () => unwrap(api.GET("/tags", { params: { query: { limit: 100 } } })),
  });
}

export function suppressionsQuery(workspaceId: number, email: string) {
  return infiniteQueryOptions({
    queryKey: ["ws", workspaceId, "suppressions", email],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/suppressions", {
          params: {
            query: {
              limit: 50,
              ...(email ? { email } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function importQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "imports", id],
    queryFn: () => unwrap(api.GET("/imports/{id}", { params: { path: { id } } })),
  });
}

// Providers, connections, and sending domains (U7) -----------------------------------------

export const providersQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: () => unwrap(api.GET("/providers")),
  staleTime: Number.POSITIVE_INFINITY,
});

export function connectionsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "connections"],
    queryFn: () => unwrap(api.GET("/connections")),
  });
}

export function connectionQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "connections", id],
    queryFn: () => unwrap(api.GET("/connections/{id}", { params: { path: { id } } })),
  });
}

export function domainsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "domains"],
    queryFn: () => unwrap(api.GET("/domains")),
  });
}

export function domainQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "domains", id],
    queryFn: () => unwrap(api.GET("/domains/{id}", { params: { path: { id } } })),
  });
}

export function testAddressesQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "test-addresses"],
    queryFn: () => unwrap(api.GET("/test-addresses")),
  });
}

// Templates and saved blocks (U8) --------------------------------------------------------

export function templatesQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "templates", "list"],
    queryFn: () => unwrap(api.GET("/templates", { params: { query: { limit: 100 } } })),
  });
}

export function templateQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "templates", "one", id],
    queryFn: () => unwrap(api.GET("/templates/{id}", { params: { path: { id } } })),
    // The editor owns the draft after the first load. A refetch would reset it.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

export function mergeFieldsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "templates", "merge-fields"],
    queryFn: () => unwrap(api.GET("/templates/merge-fields")),
  });
}

export function savedBlocksQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "saved-blocks"],
    queryFn: () => unwrap(api.GET("/saved-blocks")),
  });
}

// Campaigns (U9) ------------------------------------------------------------------------

export function campaignsQuery(workspaceId: number, limit = 100) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "campaigns", "list", limit],
    queryFn: () => unwrap(api.GET("/campaigns", { params: { query: { limit } } })),
  });
}

/** Polls while the campaign is in flight, so the counts move without a reload. */
export function campaignQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "campaigns", "one", id],
    queryFn: () => unwrap(api.GET("/campaigns/{id}", { params: { path: { id } } })),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "sending" || status === "scheduled" || status === "paused" ? 3000 : false;
    },
  });
}

export function campaignEstimateQuery(workspaceId: number, id: number, version: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "campaigns", "estimate", id, version],
    queryFn: () => unwrap(api.GET("/campaigns/{id}/estimate", { params: { path: { id } } })),
  });
}

export function campaignBatchesQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "campaigns", "batches", id],
    queryFn: () =>
      unwrap(
        api.GET("/campaigns/{id}/batches", {
          params: { path: { id }, query: { status: "uncertain" } },
        }),
      ),
  });
}

// Stats and usage (U11) ------------------------------------------------------------------

/**
 * Stats come from rollups that the event flush updates about every 30 seconds. They
 * poll while the first 48 hours run, so new opens and clicks appear without a reload.
 */
const STATS_POLL_MS = 15_000;
const STATS_WINDOW_MS = 48 * 60 * 60 * 1000;

function statsPoll(startedAt: number | null | undefined): number | false {
  return startedAt != null && Date.now() - startedAt < STATS_WINDOW_MS ? STATS_POLL_MS : false;
}

export function campaignStatsQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "campaigns", "stats", id],
    queryFn: () => unwrap(api.GET("/campaigns/{id}/stats", { params: { path: { id } } })),
    refetchInterval: (query) => statsPoll(query.state.data?.startedAt),
  });
}

export function clickMapQuery(workspaceId: number, id: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "campaigns", "click-map", id],
    queryFn: () => unwrap(api.GET("/campaigns/{id}/click-map", { params: { path: { id } } })),
  });
}

export function latestStatsQuery(workspaceId: number) {
  return queryOptions({
    queryKey: ["ws", workspaceId, "stats", "latest"],
    queryFn: () => unwrap(api.GET("/stats/latest")),
    refetchInterval: (query) => statsPoll(query.state.data?.campaign?.startedAt),
  });
}

/** The D1 budget is per account. The meter changes with every write, so it polls. */
export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: () => unwrap(api.GET("/usage")),
  refetchInterval: 60_000,
});
