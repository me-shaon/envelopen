import type { TableName } from "@envelopen/db";
import { BACKUP_SCHEMA_VERSION, type BackupRow } from "./format";

// The order and the foreign keys of a restore (U5, KTD3).
//
// D1 checks foreign keys, so the restore inserts a parent table before its children.
// RESTORE_ORDER lists every backed-up table in that order. A test compares FOREIGN_KEYS
// with `PRAGMA foreign_key_list` of every table, so a new migration with a new
// reference fails the test until this file knows it.
//
// Orphans: rows that changed during the backup can point at a parent that the backup
// does not hold (KTD2). A restore never writes a dangling reference:
// - `skip`: the column is required, or the parent deletes the child (ON DELETE
//   CASCADE). The restore leaves the row out and counts it as skipped.
// - `clear`: the reference is optional (ON DELETE SET NULL). The restore writes the
//   row with the column set to null, as a delete of the parent would.
//
// One cycle exists: workspaces.sending_connection_id points at provider_connections,
// which need their workspace. The restore writes the workspace with the column empty,
// and sets it in the finish step, after the connections are in (DEFERRED_REFERENCES).

export type OrphanRule = "skip" | "clear";

export interface ForeignKey {
  column: string;
  parent: TableName;
  /** The parent column. Every reference in the schema points at `id`. */
  parentColumn: "id";
  onMissing: OrphanRule;
}

const ws = (onMissing: OrphanRule = "skip"): ForeignKey => ({
  column: "workspace_id",
  parent: "workspaces",
  parentColumn: "id",
  onMissing,
});
const ref = (column: string, parent: TableName, onMissing: OrphanRule): ForeignKey => ({
  column,
  parent,
  parentColumn: "id",
  onMissing,
});

/** The tables in insert order. A test keeps it equal to BACKUP_TABLES as a set. */
export const RESTORE_ORDER: readonly TableName[] = [
  "users",
  "auth_user",
  "auth_account",
  "auth_verification",
  "auth_passkey",
  "workspaces",
  "system_settings",
  "backup_settings",
  "workspace_members",
  "api_keys",
  "audit_log",
  "idempotency_keys",
  "provider_connections",
  "sending_domains",
  "test_addresses",
  "provider_events",
  "templates",
  "saved_blocks",
  "campaigns",
  "contacts",
  "contact_fields",
  "contact_field_options",
  "contact_field_values",
  "lists",
  "list_members",
  "tags",
  "contact_tags",
  "consent_events",
  "forms",
  "signups",
  "form_consents",
  "suppressions",
  "consent_tombstones",
  "imports",
  "exports",
  "campaign_batches",
  "campaign_recipients",
  "confirm_tokens",
  "links",
  "email_events",
  "campaign_stats_hourly",
  "campaign_stats_daily",
  "workspace_stats_daily",
  "event_flushes",
];

/** The foreign keys of each table, as the migrations declare them. */
export const FOREIGN_KEYS: Readonly<Partial<Record<TableName, readonly ForeignKey[]>>> = {
  auth_account: [ref("userId", "auth_user", "skip")],
  auth_passkey: [ref("userId", "auth_user", "skip")],
  workspaces: [ref("sending_connection_id", "provider_connections", "clear")],
  workspace_members: [ws(), ref("user_id", "users", "skip")],
  api_keys: [ws(), ref("created_by_user_id", "users", "clear")],
  audit_log: [ws()],
  idempotency_keys: [ws()],
  provider_connections: [ws()],
  sending_domains: [ws(), ref("connection_id", "provider_connections", "clear")],
  test_addresses: [ws()],
  provider_events: [ws(), ref("connection_id", "provider_connections", "clear")],
  templates: [ws()],
  saved_blocks: [ws()],
  campaigns: [
    ws(),
    ref("parent_id", "campaigns", "clear"),
    ref("template_id", "templates", "clear"),
    ref("connection_id", "provider_connections", "clear"),
  ],
  contacts: [ws(), ref("unsubscribe_campaign_id", "campaigns", "clear")],
  contact_fields: [ws()],
  contact_field_options: [ws(), ref("field_id", "contact_fields", "skip")],
  contact_field_values: [
    ws(),
    ref("contact_id", "contacts", "skip"),
    ref("field_id", "contact_fields", "skip"),
  ],
  lists: [ws()],
  list_members: [
    ws(),
    ref("list_id", "lists", "skip"),
    ref("contact_id", "contacts", "skip"),
    ref("status_campaign_id", "campaigns", "clear"),
  ],
  tags: [ws()],
  contact_tags: [ws(), ref("contact_id", "contacts", "skip"), ref("tag_id", "tags", "skip")],
  consent_events: [ws(), ref("contact_id", "contacts", "skip")],
  forms: [ws()],
  signups: [ws(), ref("form_id", "forms", "skip")],
  form_consents: [
    ws(),
    ref("consent_event_id", "consent_events", "skip"),
    ref("form_id", "forms", "clear"),
  ],
  suppressions: [ws(), ref("campaign_id", "campaigns", "clear")],
  consent_tombstones: [ws()],
  imports: [ws()],
  exports: [ws()],
  campaign_batches: [ws(), ref("campaign_id", "campaigns", "skip")],
  campaign_recipients: [
    ws(),
    ref("campaign_id", "campaigns", "skip"),
    ref("batch_id", "campaign_batches", "clear"),
    ref("contact_id", "contacts", "clear"),
  ],
  confirm_tokens: [ws(), ref("campaign_id", "campaigns", "skip")],
  links: [ws(), ref("campaign_id", "campaigns", "skip")],
  email_events: [
    ws(),
    ref("campaign_id", "campaigns", "skip"),
    ref("recipient_id", "campaign_recipients", "skip"),
    ref("contact_id", "contacts", "clear"),
    ref("link_id", "links", "clear"),
  ],
  campaign_stats_hourly: [ws(), ref("campaign_id", "campaigns", "skip")],
  campaign_stats_daily: [ws(), ref("campaign_id", "campaigns", "skip")],
  workspace_stats_daily: [ws()],
  event_flushes: [ws()],
};

/** References that the restore writes in the finish step, after their parent table. */
export const DEFERRED_REFERENCES: readonly { table: TableName; column: string }[] = [
  { table: "workspaces", column: "sending_connection_id" },
];

/** Columns that the count triggers of migration 0014 rebuild as the members go in. */
export const TRIGGER_COUNTS: Readonly<Partial<Record<TableName, readonly string[]>>> = {
  lists: ["subscribed_count", "unsubscribed_count"],
  tags: ["contact_count"],
};

// Schema versions --------------------------------------------------------------------------

/**
 * The policy for a backup of another schema version:
 * - A newer backup is refused. Update this deployment first.
 * - An older backup is upgraded row by row, one migration at a time. UPGRADES[v] turns a
 *   row of schema v - 1 into a row of schema v. A migration that does not change a
 *   backed-up table has an identity step.
 * - A backup older than OLDEST_RESTORABLE_SCHEMA is refused: no backup exists from
 *   before the backup engine (migration 0016).
 */
export const OLDEST_RESTORABLE_SCHEMA = 16;

type Upgrade = (table: TableName, row: BackupRow) => BackupRow;
const identity: Upgrade = (_table, row) => row;

/**
 * Row upgrades by target schema version.
 * - 0017 adds only the restore tables.
 * - 0018 adds `contact_fields.kind` and the options table. A field of an older backup is
 *   a plain field, so its kind is null. An older backup has no options.
 * - 0019 adds only new tables (forms, signups, form consents). An older backup has none.
 * - 0020 adds `contact_fields.preference` and `forms.required_field_ids`. An older field
 *   stays off the preference page, and an older form requires no field.
 */
export const UPGRADES: Readonly<Record<number, Upgrade>> = {
  17: identity,
  18: (table, row) => (table === "contact_fields" ? { kind: null, ...row } : row),
  19: identity,
  20: (table, row) => {
    if (table === "contact_fields") return { preference: "hidden", ...row };
    if (table === "forms") return { required_field_ids: "[]", ...row };
    return row;
  },
};

/** Returns why a backup of `schemaVersion` cannot be restored here, or null. */
export function schemaProblem(schemaVersion: number): string | null {
  if (!Number.isInteger(schemaVersion)) return "The backup has no valid schema version.";
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    return (
      `The backup comes from a newer Envelopen (schema ${schemaVersion}). This deployment ` +
      `has schema ${BACKUP_SCHEMA_VERSION}. Update this deployment, then restore again.`
    );
  }
  if (schemaVersion < OLDEST_RESTORABLE_SCHEMA) {
    return `The backup schema ${schemaVersion} is too old to restore.`;
  }
  for (let version = schemaVersion + 1; version <= BACKUP_SCHEMA_VERSION; version++) {
    if (!UPGRADES[version]) {
      return `No upgrade exists from schema ${version - 1} to schema ${version}.`;
    }
  }
  return null;
}

/** Upgrades a row from `schemaVersion` to the current schema. */
export function upgradeRow(table: TableName, row: BackupRow, schemaVersion: number): BackupRow {
  let out = row;
  for (let version = schemaVersion + 1; version <= BACKUP_SCHEMA_VERSION; version++) {
    const step = UPGRADES[version];
    if (!step) throw new Error(`No upgrade to schema ${version}.`);
    out = step(table, out);
  }
  return out;
}
