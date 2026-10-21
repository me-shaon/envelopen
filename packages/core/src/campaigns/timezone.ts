// The timezone of a scheduled send (R8, KTD4). The UTC instant in `scheduled_at` stays
// the source of truth for the cron. The zone and the wall-clock time only record how the
// owner picked it, so the app can show the time in that zone.

/** An IANA name: letters, digits, `_`, `+`, and `-`, in parts split by `/`. No offsets. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * The canonical spelling of an IANA timezone name, or null when the runtime does not
 * know the zone. An offset such as `+06:00` is not a zone and gives null.
 */
export function canonicalTimeZone(zone: string): string | null {
  if (zone.length > 64 || !ZONE_NAME.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, format);
  }
  return format;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/**
 * The wall-clock time of an instant in a zone, with its UTC offset, to the minute:
 * `2026-10-21T09:00+06:00`. The offset tells the two occurrences of a fall-back hour
 * apart.
 */
export function localTime(instant: number, zone: string): string {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const offsetMinutes = Math.round((wall - Math.floor(instant / 1000) * 1000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${pad(parts.year ?? 0, 4)}-${pad(parts.month ?? 1)}-${pad(parts.day ?? 1)}` +
    `T${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
