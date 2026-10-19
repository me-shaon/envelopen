import { createContext, useContext } from "react";
import type { Schemas } from "@/api/client";

export interface WorkspaceContextValue {
  current: Schemas["WorkspaceSummary"];
  workspaces: Schemas["WorkspaceSummary"][];
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** The workspace that the shell resolved. Use it inside the app shell only. */
export function useCurrentWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useCurrentWorkspace needs the app shell.");
  return value;
}
