import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiRequestError } from "./api/client";
import { sessionQuery } from "./api/queries";
import { createAppRouter } from "./router";

// A 401 from the API means the session ended. Forget it and go to the login page.
function onError(error: unknown) {
  if (error instanceof ApiRequestError && error.status === 401) {
    queryClient.setQueryData(sessionQuery.queryKey, null);
    void router.navigate({ to: "/login" });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Client errors do not get better on a retry.
      retry: (count, error) =>
        !(error instanceof ApiRequestError && error.status < 500) && count < 2,
    },
  },
});

const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
