const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** A Unix millisecond time as a short date, for example "Oct 19, 2026". */
export function formatDate(ms: number | null | undefined): string {
  return ms == null ? "Never" : dateFormat.format(new Date(ms));
}

/** Up to two initials of a name, for avatars and workspace marks. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const [first = "", second] = words;
  const text = second === undefined ? first.slice(0, 2) : first.charAt(0) + second.charAt(0);
  return text.toUpperCase() || "?";
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** A Unix millisecond time with the time of day, for example "Oct 19, 2026, 2:23 AM". */
export function formatDateTime(ms: number | null | undefined): string {
  return ms == null ? "Never" : dateTimeFormat.format(new Date(ms));
}

/** A byte count in KB, MB, or GB, for example "4.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Whole days from `from` to `to`, at least 0. */
export function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}
