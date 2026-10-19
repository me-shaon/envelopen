import type { BufferedEvent, TrackingEvent } from "@envelopen/core";

// Tracking classification (KTD29, R41, R42). Flagged events are stored and counted
// apart, so reports show people only.
//
// A machine open:
// - an open from Apple's network (ASN 714) with a bare user agent: Apple Mail Privacy
//   Protection loads every image on delivery through its proxy (AE6);
// - a HEAD request, a prefetch, or a request with no user agent.
// Gmail's and Yahoo's image proxies load images when the person opens the email, so
// their opens count as human.
//
// A bot click:
// - a HEAD request or a prefetch: a person's browser sends GET;
// - a click within the bot window after the send: scanners follow links on delivery;
// - a hit on the hidden honeypot link, which no person can see;
// - a click from the network of an email security scanner;
// - a same-second burst: two or more links of one email within one second, or clicks
//   near a honeypot hit. `markBursts` finds these in each flush group.

/** Apple Inc. The Mail Privacy Protection proxy fetches from this network. */
export const APPLE_ASN = 714;

/**
 * Networks of email security gateways that follow links before delivery. Kept short on
 * purpose: a person rarely clicks from these networks, but a wrong entry hides real
 * clicks. The organization pattern catches the same vendors on other numbers.
 */
export const SCANNER_ASNS: ReadonlySet<number> = new Set([
  22843, // Proofpoint
  26211, // Proofpoint
  30031, // Mimecast
  42427, // Mimecast
  15324, // Barracuda Networks
]);
const SCANNER_ORGANIZATIONS = /\b(proofpoint|mimecast|barracuda|forcepoint|ironport)\b/i;

/** A click this soon after the provider accepted the email is a scanner's. */
export const BOT_WINDOW_MS = 30_000;
/** Clicks of one recipient this close to a honeypot hit belong to the same scanner. */
export const HONEYPOT_SPREAD_MS = 2_000;

export interface Hit {
  method: string;
  userAgent: string;
  asn: number | null;
  asOrganization: string | null;
  /** A browser prefetch (`Sec-Purpose` or `Purpose`). */
  prefetch: boolean;
}

/** The parts of a request that the classifier reads. `request.cf` is absent in some tests. */
export function hitOf(request: Request): Hit {
  const cf = (request as Request & { cf?: { asn?: unknown; asOrganization?: unknown } }).cf;
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  return {
    method: request.method.toUpperCase(),
    userAgent: (request.headers.get("user-agent") ?? "").trim(),
    asn: typeof cf?.asn === "number" ? cf.asn : null,
    asOrganization: typeof cf?.asOrganization === "string" ? cf.asOrganization : null,
    prefetch: /prefetch|prerender/i.test(purpose),
  };
}

/** A user agent with no browser detail: empty, or `Mozilla/5.0` alone. */
export function isBareUserAgent(userAgent: string): boolean {
  const value = userAgent.trim();
  return value === "" || value === "Mozilla/5.0";
}

export interface Classification {
  flagged: boolean;
  reason: string | null;
}

const human: Classification = { flagged: false, reason: null };

export function classifyOpen(hit: Hit): Classification {
  if (hit.method === "HEAD") return { flagged: true, reason: "head" };
  if (hit.prefetch) return { flagged: true, reason: "prefetch" };
  if (hit.asn === APPLE_ASN && isBareUserAgent(hit.userAgent)) {
    return { flagged: true, reason: "apple_privacy_proxy" };
  }
  if (hit.userAgent === "") return { flagged: true, reason: "no_user_agent" };
  return human;
}

export function classifyClick(
  hit: Hit,
  context: { honeypot: boolean; sentAt: number | null; now: number },
): Classification {
  if (context.honeypot) return { flagged: true, reason: "honeypot" };
  if (hit.method === "HEAD") return { flagged: true, reason: "head" };
  if (hit.prefetch) return { flagged: true, reason: "prefetch" };
  if (
    (hit.asn !== null && SCANNER_ASNS.has(hit.asn)) ||
    (hit.asOrganization !== null && SCANNER_ORGANIZATIONS.test(hit.asOrganization))
  ) {
    return { flagged: true, reason: "scanner_network" };
  }
  if (context.sentAt !== null && context.now - context.sentAt < BOT_WINDOW_MS) {
    return { flagged: true, reason: "bot_window" };
  }
  return human;
}

/**
 * Marks the bursts of one flush group as bot clicks: a recipient's clicks on two or
 * more links within one second, and a recipient's clicks within two seconds of a
 * honeypot hit. Returns new event objects; the input stays as it is.
 */
export function markBursts(events: readonly BufferedEvent[]): BufferedEvent[] {
  const clicks = new Map<number, TrackingEvent[]>();
  for (const event of events) {
    if (event.source !== "tracking" || event.type !== "click") continue;
    const list = clicks.get(event.recipientId) ?? [];
    list.push(event);
    clicks.set(event.recipientId, list);
  }
  const flagged = new Map<TrackingEvent, string>();
  for (const list of clicks.values()) {
    if (list.length < 2) continue;
    const honeypots = list.filter((event) => event.reason === "honeypot");
    const seconds = new Map<number, Set<number | null>>();
    for (const event of list) {
      const second = Math.floor(event.occurredAt / 1000);
      const links = seconds.get(second) ?? new Set();
      links.add(event.linkId);
      seconds.set(second, links);
    }
    for (const event of list) {
      if (event.bot) continue;
      const links = seconds.get(Math.floor(event.occurredAt / 1000));
      if (links && links.size >= 2) flagged.set(event, "burst");
      else if (
        honeypots.some((hit) => Math.abs(hit.occurredAt - event.occurredAt) <= HONEYPOT_SPREAD_MS)
      ) {
        flagged.set(event, "near_honeypot");
      }
    }
  }
  if (flagged.size === 0) return [...events];
  return events.map((event) => {
    const reason = event.source === "tracking" ? flagged.get(event) : undefined;
    return reason && event.source === "tracking" ? { ...event, bot: true, reason } : event;
  });
}
