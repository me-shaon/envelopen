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
