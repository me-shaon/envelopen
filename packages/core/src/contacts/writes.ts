import { type ConsentBasis, chunkedInsert, type Database } from "@envelopen/db";
import { type CompiledQuery, type Kysely, sql } from "kysely";
import { OperationError } from "../errors";

// Set-based contact writes, shared by the API upsert and the CSV import. Each helper
// returns queries for `atomic()`, so a group of writes commits together. The queries
// address contacts by email, so a contact inserted earlier in the same batch is found.
// Every query stays within D1's 100 bound parameters (KTD20).

/** Emails per `IN (...)` list. The other parameters of a query fit in the rest. */
export const EMAILS_PER_QUERY = 90;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

type SqlValue = string | number | null;

function valuesClause(rows: ReadonlyArray<ReadonlyArray<SqlValue>>) {
  return sql.join(
    rows.map((row) => sql`(${sql.join(row)})`),
    sql`, `,
  );
}

export const TAG_NAME_MAX = 60;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** Trimmed tag names without duplicates. Throws for an empty or too long name. */
export function cleanTagNames(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0 || name.length > TAG_NAME_MAX) {
      throw new OperationError(
        "invalid_input",
        `A tag name must have 1 to ${TAG_NAME_MAX} characters.`,
      );
    }
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

/**
 * Returns the ids of the named tags and creates the missing ones. Tag names match
 * without regard to case, so "Course" and "course" are one tag.
 */
export async function ensureTags(
  db: Kysely<Database>,
  workspaceId: number,
  names: readonly string[],
  now: number,
): Promise<{ id: number; name: string }[]> {
  const clean = cleanTagNames(names);
  if (clean.length === 0) return [];
  const lower = clean.map((name) => name.toLowerCase());
  const find = () =>
    db
      .selectFrom("tags")
      .select(["id", "name"])
      .where("workspace_id", "=", workspaceId)
      .where((eb) => eb(eb.fn("lower", ["name"]), "in", lower))
      .execute();
  const existing = await find();
  const known = new Set(existing.map((tag) => tag.name.toLowerCase()));
  const missing = clean.filter((name) => !known.has(name.toLowerCase()));
  if (missing.length === 0) return existing;
  for (const query of chunkedInsert(
    db,
    "tags",
    missing.map((name) => ({ workspace_id: workspaceId, name, created_at: now })),
    { modify: (insert) => insert.onConflict((conflict) => conflict.doNothing()) },
  )) {
    await query.execute();
  }
  return find();
}

/** Throws not_found unless every list id belongs to the workspace. Returns the ids without duplicates. */
export async function checkLists(
  db: Kysely<Database>,
  workspaceId: number,
  ids: readonly number[],
): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .selectFrom("lists")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "in", unique)
    .execute();
  if (rows.length !== unique.length) {
    throw new OperationError("not_found", "A list does not exist in this workspace.");
  }
  return unique;
}

/** Throws not_found unless every tag id belongs to the workspace. */
export async function checkTags(
  db: Kysely<Database>,
  workspaceId: number,
  ids: readonly number[],
): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .selectFrom("tags")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "in", unique)
    .execute();
  if (rows.length !== unique.length) {
    throw new OperationError("not_found", "A tag does not exist in this workspace.");
  }
  return unique;
}

/** Returns field ids by key and creates the missing custom fields (type text). */
export async function ensureFields(
  db: Kysely<Database>,
  workspaceId: number,
  keys: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (!FIELD_KEY_PATTERN.test(key)) {
      throw new OperationError(
        "invalid_input",
        `The field key "${key}" is not valid. Use lowercase letters, digits, and underscores.`,
      );
    }
  }
  if (unique.length === 0) return new Map();
  for (const query of chunkedInsert(
    db,
    "contact_fields",
    unique.map((key) => ({ workspace_id: workspaceId, key, label: key })),
    { modify: (insert) => insert.onConflict((conflict) => conflict.doNothing()) },
  )) {
    await query.execute();
  }
  const rows = await db
    .selectFrom("contact_fields")
    .select(["id", "key"])
    .where("workspace_id", "=", workspaceId)
    .where("key", "in", unique)
    .execute();
  return new Map(rows.map((row) => [row.key, row.id]));
}

export interface NewContactRow {
  email: string;
  emailHash: string;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Inserts new contacts. A row whose address already exists is left alone, so a
 * concurrent insert of the same address cannot fail the batch.
 */
export function insertContacts(
  db: Kysely<Database>,
  workspaceId: number,
  rows: readonly NewContactRow[],
  meta: { consentBasis: ConsentBasis; consentSource: string; source: string; now: number },
): CompiledQuery[] {
  // 7 fixed parameters and 4 per row.
  return chunk(rows, 23).map((part) =>
    sql`INSERT INTO contacts (workspace_id, email, email_hash, first_name, last_name, consent_basis, consent_source, consent_at, source, created_at, updated_at)
SELECT ${workspaceId}, column1, column2, column3, column4, ${meta.consentBasis}, ${meta.consentSource}, ${meta.now}, ${meta.source}, ${meta.now}, ${meta.now}
FROM (VALUES ${valuesClause(part.map((row) => [row.email, row.emailHash, row.firstName, row.lastName]))})
WHERE true
ON CONFLICT (workspace_id, email) DO NOTHING`.compile(db),
  );
}

/**
 * Sets first and last names of existing contacts. A null value keeps the stored name,
 * so a CSV without a name column never clears names.
 */
export function updateNames(
  db: Kysely<Database>,
  workspaceId: number,
  rows: ReadonlyArray<{ email: string; firstName: string | null; lastName: string | null }>,
  now: number,
): CompiledQuery[] {
  const changes = rows.filter((row) => row.firstName !== null || row.lastName !== null);
  // 2 fixed parameters and 3 per row.
  return chunk(changes, 32).map((part) =>
    sql`UPDATE contacts
SET first_name = coalesce(v.column2, contacts.first_name),
    last_name = coalesce(v.column3, contacts.last_name),
    updated_at = ${now}
FROM (VALUES ${valuesClause(part.map((row) => [row.email, row.firstName, row.lastName]))}) AS v
WHERE contacts.workspace_id = ${workspaceId} AND contacts.email = v.column1`.compile(db),
  );
}

/** Sets the email hash on contacts that do not have one yet, for example rows from before U6. */
export function fillEmailHashes(
  db: Kysely<Database>,
  workspaceId: number,
  rows: ReadonlyArray<{ email: string; emailHash: string }>,
): CompiledQuery[] {
  return chunk(rows, 45).map((part) =>
    sql`UPDATE contacts SET email_hash = v.column2
FROM (VALUES ${valuesClause(part.map((row) => [row.email, row.emailHash]))}) AS v
WHERE contacts.workspace_id = ${workspaceId} AND contacts.email = v.column1 AND contacts.email_hash IS NULL`.compile(
      db,
    ),
  );
}

/**
 * Appends a consent event for each contact that has none yet. New contacts get their
 * first event this way, in the same batch as the insert.
 */
export function firstConsentEvents(
  db: Kysely<Database>,
  workspaceId: number,
  emails: readonly string[],
  event: { source: string; actorType: string; actorId: string; note: string | null; now: number },
) {
  return chunk(emails, EMAILS_PER_QUERY).map((part) =>
    db
      .insertInto("consent_events")
      .columns([
        "workspace_id",
        "contact_id",
        "basis",
        "source",
        "actor_type",
        "actor_id",
        "note",
        "created_at",
      ])
      .expression((eb) =>
        eb
          .selectFrom("contacts as c")
          .select([
            "c.workspace_id",
            "c.id",
            "c.consent_basis",
            sql<string>`${event.source}`.as("source"),
            sql<string>`${event.actorType}`.as("actor_type"),
            sql<string>`${event.actorId}`.as("actor_id"),
            sql<string | null>`${event.note}`.as("note"),
            sql<number>`${event.now}`.as("created_at"),
          ])
          .where("c.workspace_id", "=", workspaceId)
          .where("c.email", "in", part)
          .where((inner) =>
            inner.not(
              inner.exists(
                inner
                  .selectFrom("consent_events as e")
                  .select("e.id")
                  .where("e.workspace_id", "=", workspaceId)
                  .whereRef("e.contact_id", "=", "c.id"),
              ),
            ),
          ),
      ),
  );
}

/**
 * Changes the consent basis of contacts whose basis is `from`, and appends the events.
 * The event insert runs first and reads the old basis, so both see the same contacts.
 */
export function changeConsent(
  db: Kysely<Database>,
  workspaceId: number,
  contactIds: readonly number[],
  change: {
    from: ConsentBasis | null;
    to: ConsentBasis;
    source: string;
    actorType: string;
    actorId: string;
    note: string | null;
    now: number;
  },
) {
  return chunk(contactIds, EMAILS_PER_QUERY).flatMap((part) => {
    const events = db
      .insertInto("consent_events")
      .columns([
        "workspace_id",
        "contact_id",
        "basis",
        "source",
        "actor_type",
        "actor_id",
        "note",
        "created_at",
      ])
      .expression((eb) => {
        let query = eb
          .selectFrom("contacts as c")
          .select([
            "c.workspace_id",
            "c.id",
            sql<ConsentBasis>`${change.to}`.as("basis"),
            sql<string>`${change.source}`.as("source"),
            sql<string>`${change.actorType}`.as("actor_type"),
            sql<string>`${change.actorId}`.as("actor_id"),
            sql<string | null>`${change.note}`.as("note"),
            sql<number>`${change.now}`.as("created_at"),
          ])
          .where("c.workspace_id", "=", workspaceId)
          .where("c.id", "in", part)
          .where("c.consent_basis", "!=", change.to);
        if (change.from !== null) query = query.where("c.consent_basis", "=", change.from);
        return query;
      });
    let update = db
      .updateTable("contacts")
      .set({
        consent_basis: change.to,
        consent_source: change.source,
        consent_at: change.now,
        updated_at: change.now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "in", part)
      .where("consent_basis", "!=", change.to);
    if (change.from !== null) update = update.where("consent_basis", "=", change.from);
    return [events, update];
  });
}

/** Adds tags to contacts by email. Existing tag links stay as they are. */
export function tagContacts(
  db: Kysely<Database>,
  workspaceId: number,
  emails: readonly string[],
  tagIds: readonly number[],
  now: number,
) {
  if (tagIds.length === 0) return [];
  const perQuery = Math.max(1, EMAILS_PER_QUERY - tagIds.length);
  return chunk(emails, perQuery).map((part) =>
    db
      .insertInto("contact_tags")
      .columns(["workspace_id", "contact_id", "tag_id", "created_at"])
      .expression((eb) =>
        eb
          .selectFrom("contacts as c")
          .innerJoin("tags as t", (join) => join.onTrue())
          .select([
            "c.workspace_id",
            "c.id",
            "t.id as tag_id",
            sql<number>`${now}`.as("created_at"),
          ])
          .where("c.workspace_id", "=", workspaceId)
          .where("c.email", "in", part)
          .where("t.workspace_id", "=", workspaceId)
          .where("t.id", "in", [...tagIds]),
      )
      .onConflict((conflict) => conflict.doNothing()),
  );
}

/**
 * Subscribes contacts to lists by email. An existing membership keeps its status, so
 * an unsubscribed member stays unsubscribed (R73).
 */
export function subscribeContacts(
  db: Kysely<Database>,
  workspaceId: number,
  emails: readonly string[],
  listIds: readonly number[],
  meta: { source: string; now: number },
) {
  if (listIds.length === 0) return [];
  const perQuery = Math.max(1, EMAILS_PER_QUERY - listIds.length);
  return chunk(emails, perQuery).map((part) =>
    db
      .insertInto("list_members")
      .columns([
        "workspace_id",
        "list_id",
        "contact_id",
        "status",
        "status_source",
        "status_at",
        "status_campaign_id",
        "created_at",
      ])
      .expression((eb) =>
        eb
          .selectFrom("contacts as c")
          .innerJoin("lists as l", (join) => join.onTrue())
          .select([
            "c.workspace_id",
            "l.id as list_id",
            "c.id as contact_id",
            sql<"subscribed">`'subscribed'`.as("status"),
            sql<string>`${meta.source}`.as("status_source"),
            sql<number>`${meta.now}`.as("status_at"),
            sql<null>`NULL`.as("status_campaign_id"),
            sql<number>`${meta.now}`.as("created_at"),
          ])
          .where("c.workspace_id", "=", workspaceId)
          .where("c.email", "in", part)
          .where("l.workspace_id", "=", workspaceId)
          .where("l.id", "in", [...listIds]),
      )
      .onConflict((conflict) => conflict.doNothing()),
  );
}

/** Sets one custom field for contacts by email. A null value clears the field. */
export function setFieldValues(
  db: Kysely<Database>,
  workspaceId: number,
  fieldId: number,
  values: ReadonlyArray<{ email: string; value: string | null }>,
  now: number,
): CompiledQuery[] {
  // 4 fixed parameters and 2 per row.
  return chunk(values, 45).map((part) =>
    sql`INSERT INTO contact_field_values (workspace_id, contact_id, field_id, value, updated_at)
SELECT c.workspace_id, c.id, ${fieldId}, v.column2, ${now}
FROM (VALUES ${valuesClause(part.map((row) => [row.email, row.value]))}) AS v
JOIN contacts c ON c.email = v.column1
WHERE c.workspace_id = ${workspaceId}
ON CONFLICT (contact_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`.compile(
      db,
    ),
  );
}
