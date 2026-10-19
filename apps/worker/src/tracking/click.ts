import { resolveClick, resolveRecipient, type TrackingEvent } from "@envelopen/core";
import { classifyClick, type Hit } from "./classify";
import type { TrackingDeps } from "./deps";

// Clicks (R40, R42): GET /t/c/<token>/<index> and the honeypot GET /t/h/<token>.
//
// - A valid token and a link index of the campaign: a 302 redirect to the stored URL,
//   for people and bots alike. The URL comes from the `links` table only, so the route
//   cannot send anyone to a URL from the request (no open redirect).
// - A forged token, an unknown recipient, or an index the campaign does not have: a
//   redirect to the generic page at /t/invalid, and nothing is recorded.
// - The honeypot answers with an empty page and records a bot click.
//
// The click is recorded after the response, through `waitUntil`.

export const INVALID_LINK_PATH = "/t/invalid";

export interface ClickOutcome {
  /** The redirect target: the stored URL, or the generic page. */
  location: string;
  /** Records the click. Null when nothing is recorded. */
  record: (() => Promise<void>) | null;
}

const INDEX = /^(0|[1-9][0-9]{0,4})$/;

export async function handleClick(
  deps: TrackingDeps,
  token: string,
  indexText: string,
  hit: Hit,
): Promise<ClickOutcome> {
  const invalid: ClickOutcome = { location: INVALID_LINK_PATH, record: null };
  if (!INDEX.test(indexText)) return invalid;
  const verified = await (await deps.signer()).verify(token);
  if (!verified) return invalid;
  const click = await resolveClick(deps.db, verified, Number(indexText));
  if (!click) return invalid;
  const now = deps.now();
  const { flagged, reason } = classifyClick(hit, { honeypot: false, sentAt: click.sentAt, now });
  const event: TrackingEvent = {
    source: "tracking",
    type: "click",
    campaignId: click.campaignId,
    recipientId: click.recipientId,
    contactId: click.contactId,
    linkId: click.linkId,
    machine: false,
    bot: flagged,
    reason,
    occurredAt: now,
  };
  return { location: click.url, record: () => deps.sink(click.workspaceId, [event]) };
}

/** The honeypot link: always a bot click, recorded for a valid token only. */
export async function recordHoneypot(
  deps: TrackingDeps,
  token: string,
): Promise<TrackingEvent | null> {
  const verified = await (await deps.signer()).verify(token);
  if (!verified) return null;
  const recipient = await resolveRecipient(deps.db, verified);
  if (!recipient) return null;
  const event: TrackingEvent = {
    source: "tracking",
    type: "click",
    campaignId: recipient.campaignId,
    recipientId: recipient.recipientId,
    contactId: recipient.contactId,
    linkId: null,
    machine: false,
    bot: true,
    reason: "honeypot",
    occurredAt: deps.now(),
  };
  await deps.sink(recipient.workspaceId, [event]);
  return event;
}
