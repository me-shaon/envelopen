import { queryOptions } from "@tanstack/react-query";
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
