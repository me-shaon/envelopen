import { useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

// The workspace that the browser session works in. The API client sends it as the
// X-Envelopen-Workspace header on every call. Without it, the Worker uses the
// owner's oldest active workspace.

export const WORKSPACE_HEADER = "X-Envelopen-Workspace";
const STORAGE_KEY = "envelopen.workspace";

const listeners = new Set<() => void>();

function parse(value: string | null): number | null {
  return value !== null && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

let current: number | null = parse(readStorage(STORAGE_KEY));

export function getWorkspaceId(): number | null {
  return current;
}

export function setWorkspaceId(id: number | null): void {
  if (id === current) return;
  current = id;
  writeStorage(STORAGE_KEY, id === null ? null : String(id));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkspaceId(): number | null {
  return useSyncExternalStore(subscribe, getWorkspaceId, getWorkspaceId);
}
