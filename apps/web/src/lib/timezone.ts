// Wall-clock times in IANA timezones (R8, KTD4). The browser converts the time that the
// owner picks in a zone to a UTC instant with the offsets of `Intl.DateTimeFormat`.
// Temporal is not used, because Safari support is not stable.
//
// Daylight saving time has two edge cases:
// - Gap: when the clocks move forward, some wall times do not exist (02:30 on a
//   spring-forward day in New York). Such a time is rejected with a hint.
// - Overlap: when the clocks move back, some wall times happen twice (01:30 on a
//   fall-back day in New York). The earlier instant is used, and the UI says so.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partFormatter(zone: string): Intl.DateTimeFormat {
  let format = partFormatters.get(zone);
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
    partFormatters.set(zone, format);
  }
  return format;
}

/** The wall-clock time of an instant in a zone, as if that wall time were UTC. */
function wallOf(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of partFormatter(zone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** The UTC offset of a zone at an instant, in milliseconds (local minus UTC). */
export function zoneOffset(instant: number, zone: string): number {
  return wallOf(instant, zone) - Math.floor(instant / 1000) * 1000;
}

/** Whether the runtime knows the zone. An offset such as `+06:00` is not a zone. */
export function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone of this browser, or UTC when the browser does not give one. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** The IANA zones that the browser knows, sorted, with UTC. */
export function timeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // An old browser: only the browser zone and UTC are offered.
  }
  return [...new Set([...zones, "UTC", browserTimeZone()])].sort();
}

/** A `YYYY-MM-DDTHH:mm` value, as a datetime-local input gives it, as if it were UTC. */
function parseWall(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  // Date.UTC rolls over an impossible date such as 02-30. Reject it instead.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }
  return wall;
}

const pad = (value: number) => String(value).padStart(2, "0");

function wallText(wall: number): string {
  const date = new Date(wall);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** The offset as `UTC+06:00`. */
export function offsetLabel(offsetMs: number): string {
  const minutes = Math.round(offsetMs / 60_000);
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export type WallTimeResult =
  | {
      ok: true;
      /** The UTC instant in milliseconds. */
      instant: number;
      /**
       * Set when the wall time happens twice in the zone (a fall-back hour). The instant
       * is the earlier one. The offsets are of the first and second occurrence.
       */
      ambiguous: { first: number; second: number } | null;
    }
  | { ok: false; reason: "invalid" | "gap"; message: string };

/**
 * Converts a wall-clock time (`YYYY-MM-DDTHH:mm`) in an IANA zone to a UTC instant.
 * A time in a spring-forward gap is rejected. A time in a fall-back overlap gives the
 * earlier instant and says that it is ambiguous.
 */
export function wallTimeToInstant(value: string, zone: string): WallTimeResult {
  const wall = parseWall(value);
  if (wall === null) {
    return { ok: false, reason: "invalid", message: "Enter a date and a time." };
  }
  if (!isTimeZone(zone)) {
    return { ok: false, reason: "invalid", message: `"${zone}" is not a known timezone.` };
  }
  // The true instant is within 14 hours of the wall time read as UTC. The offsets one
  // day before and after cover both sides of a clock change in that window.
  const offsets = new Set([
    zoneOffset(wall - DAY_MS, zone),
    zoneOffset(wall, zone),
    zoneOffset(wall + DAY_MS, zone),
  ]);
  const matches: { instant: number; offset: number }[] = [];
  for (const offset of offsets) {
    const instant = wall - offset;
    if (wallOf(instant, zone) === wall && !matches.some((m) => m.instant === instant)) {
      matches.push({ instant, offset });
    }
  }
  matches.sort((a, b) => a.instant - b.instant);
  const [first, second] = matches;
  if (!first) {
    // The clocks move forward over this time. The next valid wall time is the same
    // time plus the size of the jump.
    const before = zoneOffset(wall - DAY_MS, zone);
    const after = zoneOffset(wall + DAY_MS, zone);
    const later = wallText(wall + Math.abs(after - before));
    return {
      ok: false,
      reason: "gap",
      message:
        `${wallText(wall)} does not exist in ${zone} on that day, because the clocks ` +
        `move forward. Pick a different time, for example ${later}.`,
    };
  }
  return {
    ok: true,
    instant: first.instant,
    ambiguous: second ? { first: first.offset, second: second.offset } : null,
  };
}

/** The `YYYY-MM-DDTHH:mm` wall-clock time of an instant in a zone. */
export function instantToWallTime(instant: number, zone: string): string {
  return new Date(wallOf(instant, zone)).toISOString().slice(0, 16);
}

/** The note that the UI shows for a time that happens twice. */
export function ambiguityNote(value: string, zone: string): string | null {
  const result = wallTimeToInstant(value, zone);
  if (!result.ok || !result.ambiguous) return null;
  const time = value.slice(11, 16);
  return (
    `${time} happens twice in ${zone} on that day, because the clocks move back. ` +
    `Envelopen uses the first one (${offsetLabel(result.ambiguous.first)}).`
  );
}

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(zone: string, withYear: boolean, locale?: string): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${zone}|${withYear}`;
  let format = displayFormatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    displayFormatters.set(key, format);
  }
  return format;
}

/**
 * An instant in a zone, with the zone name: "Oct 21, 09:00 Asia/Dhaka". The year shows
 * when it is not the current year. A time that happens twice also shows its offset.
 */
export function formatInZone(
  instant: number,
  zone: string,
  options: { now?: number; locale?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const withYear =
    new Date(wallOf(instant, zone)).getUTCFullYear() !==
    new Date(wallOf(now, zone)).getUTCFullYear();
  const text = `${displayFormatter(zone, withYear, options.locale).format(new Date(instant))} ${zone}`;
  const result = wallTimeToInstant(instantToWallTime(instant, zone), zone);
  if (result.ok && result.ambiguous) {
    return `${text} (${offsetLabel(zoneOffset(instant, zone))})`;
  }
  return text;
}
