import { useCallback, useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";

// Light and dark mode. The choice is stored per browser. Without a choice, the app
// follows the system setting. index.html applies the class before the first paint.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "envelopen.theme";

const listeners = new Set<() => void>();

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  const stored = readStorage(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : systemTheme();
}

function apply(theme: Theme) {
  // Switch every color at once. Without this, every element with a color transition
  // fades on its own clock, and the page shows mixed light and dark states for a moment.
  // The pause stays until after the next style flush, so no transition starts from the
  // old colors.
  const pause = document.createElement("style");
  pause.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.append(pause);
  document.documentElement.classList.toggle("dark", theme === "dark");
  window.getComputedStyle(document.body).color;
  requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()));
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme): void {
  writeStorage(THEME_STORAGE_KEY, theme);
  apply(theme);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (readStorage(THEME_STORAGE_KEY) === null) apply(systemTheme());
  };
  media.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onSystemChange);
  };
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggle = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}
