import { type RefObject, useEffect, useRef, useState } from "react";

// Small motion helpers. CSS does the animating (see styles.css). These hooks decide
// when a motion may run: once per session for data reveals, never on a refetch, and
// never under reduced motion.

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const revealed = new Set<string>();

/**
 * True the first time a component with this key mounts in the session. The overview
 * and campaign figures count up and their bars grow on the first view only. A refetch,
 * a poll, or a return to the page shows the numbers as they are.
 */
export function useFirstReveal(key: string | null): boolean {
  // Decided once per key, so the answer holds while the reveal runs. The key can start
  // as null while the data loads.
  const decided = useRef(new Map<string, boolean>());
  if (key !== null && !decided.current.has(key)) {
    decided.current.set(key, !revealed.has(key) && !prefersReducedMotion());
  }
  useEffect(() => {
    if (key !== null) revealed.add(key);
  }, [key]);
  return key !== null && decided.current.get(key) === true;
}

/** True once the element has been on screen. */
export function useSeen(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || seen || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled, seen]);
  return !enabled || seen;
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * Counts from zero to `target` once. `armed` holds the figure at zero until `go` turns
 * true, for example when the strip scrolls into view. Without `armed` the figure shows
 * the target at once. Later changes of the target, from a poll or a refetch, show at
 * once too.
 */
export function useCountUp(target: number, armed: boolean, go: boolean, duration = 700): number {
  const [value, setValue] = useState(armed ? 0 : target);
  const done = useRef(!armed);
  const started = useRef(false);

  useEffect(() => {
    if (done.current) {
      setValue(target);
      return;
    }
    if (!go || started.current) return;
    started.current = true;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - start) / duration);
      setValue(target * easeOutExpo(progress));
      if (progress < 1) frame = requestAnimationFrame(step);
      else done.current = true;
    });
    return () => {
      cancelAnimationFrame(frame);
      started.current = false;
    };
  }, [target, go, duration]);

  return value;
}

type Key = string | number;

export interface PresenceItem<T> {
  key: Key;
  item: T;
  /** "enter" for an item added after the first render, "exit" for one on its way out. */
  state: "enter" | "idle" | "exit";
}

const EXIT_MS = 140;
const ENTER_MS = 400;

/**
 * Keeps removed items in the list for the length of their fade, and marks items that
 * arrive later, so a list can show what changed. Items in the first loaded list do not
 * animate: pass `ready` false while the data loads.
 */
export function usePresence<T>(
  items: T[],
  keyOf: (item: NoInfer<T>) => Key,
  ready = true,
): PresenceItem<T>[] {
  const firstSeen = useRef<Map<Key, number> | null>(null);
  const previous = useRef<T[]>(items);
  const [ghosts, setGhosts] = useState<{ key: Key; item: T; index: number }[]>([]);
  const now = typeof performance === "undefined" ? 0 : performance.now();

  if (firstSeen.current === null && ready) {
    firstSeen.current = new Map(items.map((item) => [keyOf(item), Number.NEGATIVE_INFINITY]));
  }
  const seen = firstSeen.current ?? new Map<Key, number>();
  if (firstSeen.current) {
    for (const item of items) {
      const key = keyOf(item);
      if (!seen.has(key)) seen.set(key, now);
    }
  }

  useEffect(() => {
    const before = previous.current;
    previous.current = items;
    if (before === items || !ready) return;
    const present = new Set(items.map(keyOf));
    const removed = before
      .map((item, index) => ({ key: keyOf(item), item, index }))
      .filter((ghost) => !present.has(ghost.key));
    if (removed.length === 0) return;
    for (const ghost of removed) seen.delete(ghost.key);
    setGhosts((value) => [...value.filter((ghost) => !present.has(ghost.key)), ...removed]);
    setTimeout(() => {
      setGhosts((value) => value.filter((ghost) => !removed.some((r) => r.key === ghost.key)));
    }, EXIT_MS + 20);
  }, [items, keyOf, seen, ready]);

  const result: PresenceItem<T>[] = items.map((item) => {
    const key = keyOf(item);
    const at = seen.get(key) ?? Number.NEGATIVE_INFINITY;
    return { key, item, state: now - at < ENTER_MS ? "enter" : "idle" };
  });
  const keys = new Set(result.map((entry) => entry.key));
  for (const ghost of ghosts) {
    if (keys.has(ghost.key)) continue;
    result.splice(Math.min(ghost.index, result.length), 0, {
      key: ghost.key,
      item: ghost.item,
      state: "exit",
    });
  }
  return result;
}

/** The class for a presence state. */
export function presenceClass(state: PresenceItem<unknown>["state"]): string | undefined {
  if (state === "enter") return "motion-enter";
  if (state === "exit") return "motion-exit";
  return undefined;
}
