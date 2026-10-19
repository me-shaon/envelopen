import type { DbConnection, Row } from "@envelopen/db";
import { OperationError } from "../errors";
import type { Principal } from "../principal";
import { CONFIRM_TOKEN_TTL_MS } from "./model";

// Prepare and confirm (R68). Prepare issues a short-lived token. Confirm spends it. The
// token binds:
// - the actor: a token from one API key or session fails for another;
// - the campaign version, which covers the content and the audience definition: any
//   edit increments it, so the token goes stale;
// - the mode (send now or schedule) and the scheduled time.
//
// The token does not bind the recipient list. Contacts that join a targeted list after
// prepare do not stale it, because the snapshot happens at send time (KTD22).
//
// Only the SHA-256 hash of the token is stored. A compare-and-set on `used_at` makes it
// single use, even for two confirms that race.

export type ConfirmMode = "send_now" | "schedule";

/** Why a confirm failed. The UI shows a state for each. */
export type ConfirmFailure = "invalid" | "expired" | "used" | "actor" | "stale";

export interface IssuedToken {
  token: string;
  expiresAt: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function hashConfirmToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function confirmError(reason: ConfirmFailure, message: string): OperationError {
  return new OperationError(reason === "actor" ? "forbidden" : "conflict", message, { reason });
}

export async function issueConfirmToken(
  db: DbConnection,
  principal: Principal,
  input: {
    campaignId: number;
    campaignVersion: number;
    mode: ConfirmMode;
    scheduledAt: number | null;
    estimatedRecipients: number;
  },
  now: number,
): Promise<IssuedToken> {
  const token = `ect_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const expiresAt = now + CONFIRM_TOKEN_TTL_MS;
  await db.db
    .insertInto("confirm_tokens")
    .values({
      workspace_id: principal.workspaceId,
      campaign_id: input.campaignId,
      token_hash: await hashConfirmToken(token),
      campaign_version: input.campaignVersion,
      actor_type: principal.actorType,
      actor_id: principal.actorId,
      mode: input.mode,
      scheduled_at: input.scheduledAt,
      estimated_recipients: input.estimatedRecipients,
      expires_at: expiresAt,
      used_at: null,
    })
    .execute();
  return { token, expiresAt };
}

/**
 * Checks and spends a token. Throws a `conflict` (or `forbidden` for another actor)
 * whose details carry the reason. On success the token is used and cannot work again.
 */
export async function consumeConfirmToken(
  db: DbConnection,
  principal: Principal,
  campaign: { id: number; version: number },
  token: string,
  now: number,
): Promise<Row<"confirm_tokens">> {
  const row = await db.db
    .selectFrom("confirm_tokens")
    .selectAll()
    .where("workspace_id", "=", principal.workspaceId)
    .where("campaign_id", "=", campaign.id)
    .where("token_hash", "=", await hashConfirmToken(token))
    .executeTakeFirst();
  if (!row)
    throw confirmError("invalid", "The confirm token is not valid. Prepare the send again.");
  if (row.actor_type !== principal.actorType || row.actor_id !== principal.actorId) {
    throw confirmError("actor", "This confirm token was issued to someone else.");
  }
  if (row.used_at !== null) throw confirmError("used", "This confirm token was already used.");
  if (row.expires_at <= now) {
    throw confirmError("expired", "The confirm token expired. Prepare the send again.");
  }
  if (row.campaign_version !== campaign.version) {
    throw confirmError(
      "stale",
      "The campaign changed after you prepared the send. Review it and prepare again.",
    );
  }
  const spent = await db.db
    .updateTable("confirm_tokens")
    .set({ used_at: now })
    .where("workspace_id", "=", principal.workspaceId)
    .where("id", "=", row.id)
    .where("used_at", "is", null)
    .executeTakeFirst();
  if (Number(spent.numUpdatedRows) === 0) {
    throw confirmError("used", "This confirm token was already used.");
  }
  return { ...row, used_at: now };
}
