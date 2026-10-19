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
