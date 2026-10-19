import { resolveRecipient, type TrackingEvent } from "@envelopen/core";
import { classifyOpen, type Hit } from "./classify";
import type { TrackingDeps } from "./deps";

// The open pixel: GET (or HEAD) /t/o/<token> (R40). The response is always the same
// transparent GIF, at once, for any token: a forged or unknown token gets the image and
// records nothing (the event flow). The lookup and the hand-off to the EventBuffer run
// after the response, through `waitUntil`.

/** A 1x1 transparent GIF. */
export const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (char) => char.charCodeAt(0),
);

export function pixelResponse(method: string): Response {
  return new Response(method === "HEAD" ? null : PIXEL_GIF, {
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL_GIF.byteLength),
      // Each load must reach the Worker, so caches keep nothing.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "x-robots-tag": "noindex",
    },
  });
}

/** Verifies the token, looks up the recipient, classifies the open, and buffers it. */
export async function recordOpen(
  deps: TrackingDeps,
  token: string,
  hit: Hit,
  now: number,
): Promise<TrackingEvent | null> {
  const verified = await (await deps.signer()).verify(token);
  if (!verified) return null;
  const recipient = await resolveRecipient(deps.db, verified);
  if (!recipient) return null;
  const { flagged, reason } = classifyOpen(hit);
  const event: TrackingEvent = {
    source: "tracking",
    type: "open",
    campaignId: recipient.campaignId,
    recipientId: recipient.recipientId,
    contactId: recipient.contactId,
    linkId: null,
    machine: flagged,
    bot: false,
    reason,
    occurredAt: now,
  };
  await deps.sink(recipient.workspaceId, [event]);
  return event;
}
