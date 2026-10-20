import type { ConsentBasis } from "@envelopen/db";
import { CONSENT_UPGRADE_BLOCKED, consentDecision } from "../consent/rules";
import { OperationError } from "../errors";
import type { OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { normalizeEmail } from "./email";
import { actorSource } from "./model";
import {
  changeConsent,
  checkLists,
  ensureFields,
  ensureTags,
  fillEmailHashes,
  firstConsentEvents,
  insertContacts,
  setFieldValues,
  subscribeContacts,
  tagContacts,
} from "./writes";

export interface UpsertContactInput {
  email: string;
  /** Undefined keeps the stored name. Null clears it. */
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  /** The basis for a new contact (default `unknown`), or a change for an existing one. */
  consentBasis?: ConsentBasis | undefined;
  consentNote?: string | undefined;
  tags?: readonly string[] | undefined;
  listIds?: readonly number[] | undefined;
  fields?: Readonly<Record<string, string | null>> | undefined;
}

export interface UpsertContactResult {
  contactId: number;
  created: boolean;
  warnings: string[];
}

/**
 * Creates or updates one contact by email (R57, R73), in one atomic batch:
 * - The address is trimmed and lowercased before the lookup.
 * - An unsubscribed contact stays unsubscribed, and a list membership keeps its status.
 * - A suppression is never touched.
 * - An API key cannot raise a basis of `unknown`, also not for an address that was deleted
 *   with that basis. The upsert then succeeds with a warning.
 * - A new contact records the source `api_key:<id>` or `ui`, and a first consent event.
 */
export async function upsertContact(
  ctx: OperationContext,
  input: UpsertContactInput,
): Promise<UpsertContactResult> {
  const { principal, db, now } = ctx;
  const workspaceId = principal.workspaceId;
  const email = normalizeEmail(input.email);
  if (!email) throw new OperationError("invalid_input", "The email address is not valid.");
  const emailHash = await requireService(ctx.services, "hashEmail")(email);
  const source = actorSource(principal);

  const existing = await db.db
    .selectFrom("contacts")
    .select(["id", "consent_basis", "email_hash"])
    .where("workspace_id", "=", workspaceId)
    .where("email", "=", email)
    .executeTakeFirst();

  const tags = await ensureTags(db.db, workspaceId, input.tags ?? [], now);
  const listIds = await checkLists(db.db, workspaceId, input.listIds ?? []);
  const fieldEntries = Object.entries(input.fields ?? {});
  const fieldIds = await ensureFields(
    db.db,
    workspaceId,
    fieldEntries.map(([key]) => key),
  );

  const warnings: string[] = [];
  const consentEvent = {
    source,
    actorType: principal.actorType,
    actorId: principal.actorId,
    note: input.consentNote ?? null,
    now,
  };
  const writes = [];
  if (!existing) {
    // A contact deleted with a basis of `unknown` keeps it when an API key adds the
    // address again (consent_tombstones). The owner may set any basis.
    let consentBasis = input.consentBasis ?? "unknown";
    if (consentBasis !== "unknown" && principal.actorType === "api_key") {
      const tombstone = await db.db
        .selectFrom("consent_tombstones")
        .select("consent_basis")
        .where("workspace_id", "=", workspaceId)
        .where("email_hash", "=", emailHash)
        .executeTakeFirst();
      if (
        tombstone &&
        consentDecision(principal, tombstone.consent_basis, consentBasis) === "blocked"
      ) {
        consentBasis = tombstone.consent_basis;
        warnings.push(CONSENT_UPGRADE_BLOCKED);
      }
    }
    writes.push(
      ...insertContacts(
        db.db,
        workspaceId,
        [
          {
            email,
            emailHash,
            firstName: input.firstName ?? null,
            lastName: input.lastName ?? null,
          },
        ],
        {
          consentBasis,
          consentSource: source,
          source,
          now,
        },
      ),
      ...firstConsentEvents(db.db, workspaceId, [email], consentEvent),
    );
  } else {
    const names: { first_name?: string | null; last_name?: string | null } = {};
    if (input.firstName !== undefined) names.first_name = input.firstName;
    if (input.lastName !== undefined) names.last_name = input.lastName;
    if (Object.keys(names).length > 0) {
      writes.push(
        db.db
          .updateTable("contacts")
          .set({ ...names, updated_at: now })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", existing.id),
      );
    }
    if (existing.email_hash === null) {
      writes.push(...fillEmailHashes(db.db, workspaceId, [{ email, emailHash }]));
    }
    const decision = consentDecision(principal, existing.consent_basis, input.consentBasis);
    if (decision === "blocked") warnings.push(CONSENT_UPGRADE_BLOCKED);
    if (decision === "apply" && input.consentBasis) {
      writes.push(
        ...changeConsent(db.db, workspaceId, [existing.id], {
          ...consentEvent,
          from: existing.consent_basis,
          to: input.consentBasis,
        }),
      );
    }
  }

  writes.push(
    ...tagContacts(
      db.db,
      workspaceId,
      [email],
      tags.map((tag) => tag.id),
      now,
    ),
    ...subscribeContacts(db.db, workspaceId, [email], listIds, { source, now }),
  );
  for (const [key, value] of fieldEntries) {
    const fieldId = fieldIds.get(key);
    if (fieldId !== undefined) {
      writes.push(...setFieldValues(db.db, workspaceId, fieldId, [{ email, value }], now));
    }
  }
  await db.atomic(writes);

  const row = await db.db
    .selectFrom("contacts")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { contactId: row.id, created: !existing, warnings };
}
