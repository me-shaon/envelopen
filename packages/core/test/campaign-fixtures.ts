import type { ConsentBasis, DbConnection } from "@envelopen/db";
import { sql } from "kysely";
import type { CredentialCipher } from "../src/crypto/credentials";
import { sessionPrincipal } from "../src/principal";
import type { EmailHasher } from "../src/services";

// A workspace that can send a campaign: an owner, a provider connection, a verified
// sending domain, a template with an unsubscribe link, and a list of contacts. The
// core and Worker campaign tests share it.

export const CAMPAIGN_HTML =
  '<html><body><p>Hello {{ first_name | default: "there" }}</p>' +
  '<p><a href="https://example.com/course">See the course</a></p>' +
  '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>';

export interface SeedOptions {
  provider?: string;
  /** Contacts to add to the list. */
  contacts?: number;
  consent?: ConsentBasis;
  /** Leave the domain unverified. */
  unverifiedDomain?: boolean;
  /** Template HTML. Defaults to CAMPAIGN_HTML. */
  html?: string;
  name?: string;
}

export interface SeededWorkspace {
  workspaceId: number;
  userId: string;
  connectionId: number;
  domainId: number;
  listId: number;
  templateId: number;
  principal: ReturnType<typeof sessionPrincipal>;
}

export async function seedCampaignWorkspace(
  conn: DbConnection,
  deps: { credentials: CredentialCipher; hashEmail: EmailHasher },
  options: SeedOptions = {},
): Promise<SeededWorkspace> {
  const userId = crypto.randomUUID();
  await conn.db
    .insertInto("users")
    .values({ id: userId, email: `${userId}@example.com`, name: null })
    .execute();
  const workspace = await conn.db
    .insertInto("workspaces")
    .values({ name: options.name ?? "Campaigns" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const workspaceId = workspace.id;
  await conn.db
    .insertInto("workspace_members")
    .values({ workspace_id: workspaceId, user_id: userId, role: "owner" })
    .execute();
  const provider = options.provider ?? "resend";
  const credentials =
    provider === "ses"
      ? { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", region: "us-east-1" }
      : provider === "postmark"
        ? { serverToken: "pm-token", messageStream: "broadcast" }
        : provider === "cloudflare"
          ? { accountId: "acc", apiToken: "token" }
          : { apiKey: "re_test_key" };
  const connection = await conn.db
    .insertInto("provider_connections")
    .values({
      workspace_id: workspaceId,
      provider,
      name: provider,
      policy:
        provider === "tosend" || provider === "cloudflare" ? "transactional-only" : "campaign",
      credentials_encrypted: await deps.credentials.encrypt(JSON.stringify(credentials), {
        workspaceId,
        purpose: "credentials",
      }),
      credentials_key_version: deps.credentials.version,
      webhook_secret_encrypted: null,
      events_setup: "none",
      provider_refs: "{}",
      status: "active",
      status_detail: null,
      policy_warning_accepted_at:
        provider === "tosend" || provider === "cloudflare" ? Date.now() : null,
      policy_warning_accepted_by: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await conn.db
    .updateTable("workspaces")
    .set({ sending_connection_id: connection.id })
    .where("id", "=", workspaceId)
    .execute();
  const domain = await conn.db
    .insertInto("sending_domains")
    .values({
      workspace_id: workspaceId,
      connection_id: connection.id,
      domain: "mail.example.com",
      tracking_domain: null,
      last_checked_at: null,
      verified_at: options.unverifiedDomain ? null : Date.now(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const list = await conn.db
    .insertInto("lists")
    .values({ workspace_id: workspaceId, name: "Students", description: null })
    .returning("id")
    .executeTakeFirstOrThrow();
  const template = await conn.db
    .insertInto("templates")
    .values({
      workspace_id: workspaceId,
      name: "Course",
      subject: 'A new course for {{ first_name | default: "you" }}',
      preheader: "It starts next week",
      format: "html",
      source: options.html ?? CAMPAIGN_HTML,
      html: options.html ?? CAMPAIGN_HTML,
      text: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (options.contacts) {
    await addContacts(conn, deps.hashEmail, workspaceId, list.id, options.contacts, {
      consent: options.consent,
    });
  }
  return {
    workspaceId,
    userId,
    connectionId: connection.id,
    domainId: domain.id,
    listId: list.id,
    templateId: template.id,
    principal: sessionPrincipal({ workspaceId, userId }),
  };
}

/**
 * Adds `count` contacts, subscribed to the list, with set-based inserts. Emails are
 * `<prefix><n>@example.org`. Returns the contact ids in order.
 */
export async function addContacts(
  conn: DbConnection,
  hashEmail: EmailHasher,
  workspaceId: number,
  listId: number,
  count: number,
  options: { consent?: ConsentBasis; prefix?: string; start?: number } = {},
): Promise<number[]> {
  const prefix = options.prefix ?? "student";
  const start = options.start ?? 1;
  const ids: number[] = [];
  const now = Date.now();
  for (let offset = 0; offset < count; offset += 7) {
    const rows = [];
    for (let n = offset; n < Math.min(count, offset + 7); n++) {
      const email = `${prefix}${start + n}@example.org`;
      rows.push({ email, hash: await hashEmail(email), first: `Name${start + n}` });
    }
    const inserted = await conn.db
      .insertInto("contacts")
      .values(
        rows.map((row) => ({
          workspace_id: workspaceId,
          email: row.email,
          email_hash: row.hash,
          first_name: row.first,
          last_name: null,
          consent_basis: options.consent ?? "existing_customer",
          consent_source: "test",
          consent_at: now,
          source: "test",
          unsubscribed_at: null,
          unsubscribe_source: null,
          unsubscribe_campaign_id: null,
        })),
      )
      .returning("id")
      .execute();
    ids.push(...inserted.map((row) => row.id));
  }
  // One set-based membership insert for all new contacts of the workspace.
  await sql`INSERT INTO list_members (workspace_id, list_id, contact_id, status, status_source, status_at)
SELECT ${workspaceId}, ${listId}, id, 'subscribed', 'test', ${now} FROM contacts
WHERE workspace_id = ${workspaceId} AND id >= ${ids[0] ?? 0}
ON CONFLICT (list_id, contact_id) DO NOTHING`.execute(conn.db);
  return ids;
}

/** A draft campaign to the list, with the template's content. */
export async function createDraft(
  conn: DbConnection,
  seeded: SeededWorkspace,
  extra: { type?: "regular" | "re-permission"; listIds?: number[]; tagIds?: number[] } = {},
): Promise<number> {
  const template = await conn.db
    .selectFrom("templates")
    .select(["html", "subject", "preheader"])
    .where("workspace_id", "=", seeded.workspaceId)
    .where("id", "=", seeded.templateId)
    .executeTakeFirstOrThrow();
  const row = await conn.db
    .insertInto("campaigns")
    .values({
      workspace_id: seeded.workspaceId,
      parent_id: null,
      type: extra.type ?? "regular",
      name: "Course launch",
      pause_reason: null,
      template_id: seeded.templateId,
      connection_id: null,
      subject: template.subject,
      preheader: template.preheader,
      from_name: "Course Academy",
      from_email: "news@mail.example.com",
      reply_to: null,
      html: template.html,
      text: null,
      audience: JSON.stringify({
        listIds: extra.listIds ?? [seeded.listId],
        tagIds: extra.tagIds ?? [],
        excludeListIds: [],
        excludeTagIds: [],
      }),
      scheduled_at: null,
      started_at: null,
      completed_at: null,
      snapshot_max_contact_id: null,
      recipient_count: null,
      resume_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Adds `count` subscribed contacts with set-based SQL, for large audiences. The email
 * hash stays empty, which the suppression join treats as "not suppressed".
 */
export async function bulkContacts(
  conn: DbConnection,
  workspaceId: number,
  listId: number,
  count: number,
  prefix = "bulk",
): Promise<void> {
  const now = Date.now();
  await sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
INSERT INTO contacts (workspace_id, email, first_name, consent_basis, consent_source, consent_at, source)
SELECT ${workspaceId}, ${prefix} || i || '@example.org', 'Name' || i, 'existing_customer', 'test', ${now}, 'test' FROM n`.execute(
    conn.db,
  );
  await sql`INSERT INTO list_members (workspace_id, list_id, contact_id, status, status_source, status_at)
SELECT ${workspaceId}, ${listId}, id, 'subscribed', 'test', ${now} FROM contacts
WHERE workspace_id = ${workspaceId} AND email LIKE ${`${prefix}%`}
ON CONFLICT (list_id, contact_id) DO NOTHING`.execute(conn.db);
}
