import { type DbConnection, type Row, unscoped } from "@envelopen/db";
import {
  esc,
  FORM_COPY,
  type FormPageError,
  type FormPageForm,
} from "@envelopen/email-render/form-page";
import { sendingConnection } from "../connections/policy-gate";
import { sendSystemEmail } from "../connections/send";
import { normalizeEmail } from "../contacts/email";
import type { FieldDef, FieldInput } from "../contacts/fields";
import { isOperationError } from "../errors";
import { requireService, type Services } from "../services";
import { checkAnswers } from "./answers";
import {
  formFieldDefs,
  idList,
  MAX_SIGNUP_RESENDS,
  PUBLIC_ID_PATTERN,
  pageFields,
  SIGNUP_TOKEN_TTL_MS,
} from "./model";

// A signup through a form (U8, F1, KTD7). The Worker route checks the request (the IP
// limit, the form values, and Turnstile), then calls `submitSignup`. Every submission
// gets the same "check your inbox" page. This module decides whether a confirmation
// email goes out:
//
// - A suppressed address (keyed hash, which also covers an erased address) gets nothing.
// - An address that is already subscribed to every list of the form gets nothing.
// - A contact with an unsubscribe that waits in the UnsubscribeLedger gets nothing (KTD1).
// - At the D1 daily limit, nothing is written or sent (KTD9: confirmation emails stop
//   only at the platform limit).
// - Rate limits: one confirmation email per address per hour (submit and resend
//   together), a cap per form per hour, and a cap per workspace per day.
//
// Otherwise the signup row gets a new token (32 random bytes, stored as its SHA-256), and
// the email goes out through the workspace's connection as system email.
//
// With a daily cap on the connection (U19), the email reserves one message from the
// rolling counter that campaigns and welcome emails share. When the cap has no room, the
// email waits in a small outbox: the signup keeps the link origin in `deferred_origin`,
// and the cron sends it with a new token when the counter has room
// (`sendDeferredConfirmations`). The subscriber sees the same "check your inbox" page,
// and the connection page shows the owner how many emails wait. Nothing is dropped. A pending
// signup is never a list member, so campaigns cannot reach it (AE2).

/** One counter with a fixed window, as the AuthRateLimiter Durable Object keeps it. */
export interface CountRule {
  limit: number;
  windowMs: number;
}

/** Counts one event for a key and returns the count in the current window. */
export interface CountLimiter {
  record(key: string, rule: CountRule): Promise<{ count: number }>;
}

/** One confirmation email per address per hour, across submissions and resends. */
export const ADDRESS_EMAIL_RULE: CountRule = { limit: 1, windowMs: 60 * 60 * 1000 };
/** Confirmation emails per form per hour. */
export const FORM_EMAIL_RULE: CountRule = { limit: 200, windowMs: 60 * 60 * 1000 };
/** Confirmation emails per workspace per day. */
export const WORKSPACE_EMAIL_RULE: CountRule = { limit: 1000, windowMs: 24 * 60 * 60 * 1000 };

export const signupLimitKeys = {
  address: (workspaceId: number, emailHash: string) =>
    `form-email:address:${workspaceId}:${emailHash}`,
  form: (formId: number) => `form-email:form:${formId}`,
  workspace: (workspaceId: number) => `form-email:workspace:${workspaceId}`,
};

export interface SignupDeps {
  db: DbConnection;
  services: Partial<Services>;
  now: number;
  limiter: CountLimiter;
  /** The platform_limit flag and the ledger flag of the UsageMeter. */
  usage(): Promise<{ limited: boolean; unsubscribesPending: boolean }>;
  /** The contacts with an unsubscribe in the UnsubscribeLedger (KTD1). */
  pendingUnsubscribes(workspaceId: number, contactIds: readonly number[]): Promise<Set<number>>;
}

/** A form that the public routes can show, with its workspace. */
export interface PublicForm {
  row: Row<"forms">;
  workspaceName: string;
  defs: FieldDef[];
  /** The ids of the fields that the form requires. */
  required: ReadonlySet<number>;
  page: FormPageForm;
}

/** The form of a public id, or null when it does not exist. */
export async function loadPublicForm(
  db: DbConnection,
  publicId: string,
): Promise<PublicForm | null> {
  if (!PUBLIC_ID_PATTERN.test(publicId)) return null;
  // The public id is the only key that the visitor has. It is random and unique.
  const row = await unscoped(db.db)
    .selectFrom("forms")
    .selectAll()
    .where("public_id", "=", publicId)
    .executeTakeFirst();
  if (!row) return null;
  return publicFormOf(db, row);
}

async function publicFormOf(db: DbConnection, row: Row<"forms">): Promise<PublicForm> {
  const workspace = await db.db
    .selectFrom("workspaces")
    .select(["name", "archived_at"])
    .where("id", "=", row.workspace_id)
    .executeTakeFirstOrThrow();
  const defs = await formFieldDefs(db.db, row.workspace_id, idList(row.field_ids));
  const required = new Set(idList(row.required_field_ids));
  return {
    row,
    workspaceName: workspace.name,
    defs,
    required,
    page: {
      name: row.name,
      consentText: row.consent_text,
      successMessage: row.success_message,
      fields: pageFields(defs, required),
    },
  };
}

// Values ------------------------------------------------------------------------------------

export interface RawSubmission {
  email: string;
  /** Form values of the custom fields, by field key. */
  fields: Readonly<Record<string, readonly string[]>>;
}

export type ValidatedSubmission =
  | { ok: true; email: string; values: Record<string, FieldInput> }
  | { ok: false; errors: FormPageError[] };

/**
 * Checks the email address and the custom fields that the form shows. Other fields are
 * ignored. A choice field takes only the ids of its own options, so a forged id fails. A
 * field in `required` (by id) must have an answer.
 */
export function validateSubmission(
  defs: readonly FieldDef[],
  raw: RawSubmission,
  required: ReadonlySet<number> = new Set(),
): ValidatedSubmission {
  const email = normalizeEmail(raw.email);
  const errors: FormPageError[] = email
    ? []
    : [{ target: "email", message: FORM_COPY.emailInvalid }];
  const answers = checkAnswers(defs, raw.fields, required);
  errors.push(...answers.errors);
  if (errors.length > 0 || !email) return { ok: false, errors };
  return { ok: true, email, values: answers.values };
}

// Tokens --------------------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A new confirmation token: 32 random bytes, base64url. */
export function newSignupToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The stored form of a token: SHA-256 as lowercase hex. */
export async function hashSignupToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const SIGNUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function confirmPath(token: string): string {
  return `/f/confirm/${token}`;
}

// Checks before an email -----------------------------------------------------------------------

export type SendSkip =
  | "suppressed"
  | "subscribed"
  | "unsubscribe_pending"
  | "platform_limit"
  | "rate_limited";

async function isSuppressed(db: DbConnection, workspaceId: number, emailHash: string) {
  const row = await db.db
    .selectFrom("suppressions")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("email_hash", "=", emailHash)
    .executeTakeFirst();
  return row !== undefined;
}

/** The lists of the form that still exist. */
async function formLists(db: DbConnection, row: Row<"forms">): Promise<number[]> {
  const ids = idList(row.list_ids);
  if (ids.length === 0) return [];
  const rows = await db.db
    .selectFrom("lists")
    .select("id")
    .where("workspace_id", "=", row.workspace_id)
    .where("id", "in", ids)
    .execute();
  return rows.map((list) => list.id);
}

/** True when the contact gets mail from every list of the form already. */
async function alreadySubscribed(
  db: DbConnection,
  workspaceId: number,
  contact: { id: number; unsubscribed_at: number | null },
  listIds: readonly number[],
): Promise<boolean> {
  if (contact.unsubscribed_at !== null || listIds.length === 0) return false;
  const rows = await db.db
    .selectFrom("list_members")
    .select("list_id")
    .where("workspace_id", "=", workspaceId)
    .where("contact_id", "=", contact.id)
    .where("status", "=", "subscribed")
    .where("list_id", "in", [...listIds])
    .execute();
  return rows.length === listIds.length;
}

/** Counts the email against the three limits. False when one of them is over. */
async function allowEmail(
  deps: SignupDeps,
  form: Row<"forms">,
  emailHash: string,
): Promise<boolean> {
  const address = await deps.limiter.record(
    signupLimitKeys.address(form.workspace_id, emailHash),
    ADDRESS_EMAIL_RULE,
  );
  if (address.count > ADDRESS_EMAIL_RULE.limit) return false;
  const perForm = await deps.limiter.record(signupLimitKeys.form(form.id), FORM_EMAIL_RULE);
  if (perForm.count > FORM_EMAIL_RULE.limit) return false;
  const perWorkspace = await deps.limiter.record(
    signupLimitKeys.workspace(form.workspace_id),
    WORKSPACE_EMAIL_RULE,
  );
  return perWorkspace.count <= WORKSPACE_EMAIL_RULE.limit;
}

/** The checks that every confirmation email passes, in order. Null when it may go out. */
async function sendSkip(
  deps: SignupDeps,
  form: Row<"forms">,
  email: string,
  emailHash: string,
): Promise<SendSkip | null> {
  const { db } = deps;
  const workspaceId = form.workspace_id;
  if (await isSuppressed(db, workspaceId, emailHash)) return "suppressed";
  const contact = await db.db
    .selectFrom("contacts")
    .select(["id", "unsubscribed_at"])
    .where("workspace_id", "=", workspaceId)
    .where("email", "=", email)
    .executeTakeFirst();
  const usage = await deps.usage();
  if (contact) {
    if (await alreadySubscribed(db, workspaceId, contact, await formLists(db, form))) {
      return "subscribed";
    }
    if (usage.unsubscribesPending) {
      const waiting = await deps.pendingUnsubscribes(workspaceId, [contact.id]);
      if (waiting.has(contact.id)) return "unsubscribe_pending";
    }
  }
  if (usage.limited) return "platform_limit";
  if (!(await allowEmail(deps, form, emailHash))) return "rate_limited";
  return null;
}

// The email -------------------------------------------------------------------------------------

function mailbox(name: string, email: string): string {
  const clean = name.replaceAll(/["<>\r\n]/g, "").trim();
  return clean ? `${clean} <${email}>` : email;
}

async function senderOf(db: DbConnection, form: Row<"forms">, workspaceName: string) {
  const name = form.from_name ?? workspaceName;
  if (form.from_email) return mailbox(name, form.from_email);
  const domain = await db.db
    .selectFrom("sending_domains")
    .select("domain")
    .where("workspace_id", "=", form.workspace_id)
    .where("verified_at", "is not", null)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();
  return domain ? mailbox(name, `noreply@${domain.domain}`) : null;
}

export function confirmationEmail(formName: string, link: string) {
  const name = formName.replaceAll(/[\r\n]+/g, " ").trim();
  const subject = `Confirm your subscription to ${name}`.slice(0, 200);
  const html =
    `<p>Select the link below to confirm your subscription to <strong>${esc(name)}</strong>.</p>` +
    `<p><a href="${esc(link)}">Confirm my subscription</a></p>` +
    `<p>The link is valid for 72 hours. If you did not ask for this subscription, ignore this email. You will get no more email from us.</p>`;
  const text =
    `Open this link to confirm your subscription to ${name}:\n\n${link}\n\n` +
    "The link is valid for 72 hours. If you did not ask for this subscription, ignore this email. You will get no more email from us.";
  return { subject, html, text };
}

export type SendResult = "sent" | "send_failed" | "deferred";

/** A reservation from the daily counter. `release` gives it back when nothing went out. */
interface Reservation {
  release(): Promise<void>;
}

const NO_RESERVATION: Reservation = { release: async () => {} };

/**
 * Reserves one message from the daily counter of the workspace's connection. Null when
 * the cap has no room. A connection without a cap needs no reservation.
 */
async function reserveConfirmation(
  db: DbConnection,
  services: Partial<Services>,
  workspaceId: number,
): Promise<Reservation | null> {
  const counter = services.dailyCounter;
  if (!counter) return NO_RESERVATION;
  const connection = await sendingConnection(db, workspaceId);
  if (!connection || connection.daily_cap === null) return NO_RESERVATION;
  const grant = await counter.reserve(connection.id, 1, connection.daily_cap);
  if (!grant.granted) return null;
  return { release: () => counter.release(connection.id, 1, grant.at) };
}

async function sendConfirmation(
  deps: Pick<SignupDeps, "db" | "services">,
  form: Row<"forms">,
  workspaceName: string,
  to: string,
  link: string,
  reservation: Reservation,
): Promise<SendResult> {
  const result = await sendConfirmationEmail(deps, form, workspaceName, to, link);
  if (result !== "sent") await reservation.release().catch(() => {});
  return result;
}

async function sendConfirmationEmail(
  deps: Pick<SignupDeps, "db" | "services">,
  form: Row<"forms">,
  workspaceName: string,
  to: string,
  link: string,
): Promise<SendResult> {
  try {
    const from = await senderOf(deps.db, form, workspaceName);
    if (!from) {
      console.error(`Form ${form.id}: no verified sending domain for the confirmation email`);
      return "send_failed";
    }
    const result = await sendSystemEmail(
      { db: deps.db, services: deps.services },
      form.workspace_id,
      { to, from, ...confirmationEmail(form.name, link) },
    );
    if (result?.outcome === "sent" || result?.outcome === "unknown") return "sent";
    console.error(
      `Form ${form.id}: the provider did not send the confirmation email`,
      result?.message,
    );
    return "send_failed";
  } catch (error) {
    if (isOperationError(error)) console.error(`Form ${form.id}: ${error.message}`);
    else console.error(`Form ${form.id}: the confirmation email failed`, error);
    return "send_failed";
  }
}

// Submit and resend ---------------------------------------------------------------------------------

export interface SubmitInput {
  email: string;
  values: Record<string, FieldInput>;
  /** Keyed hash of the IP address. */
  ipHash: string | null;
  userAgent: string | null;
  /** The https origin of the confirmation link. */
  origin: string;
}

export type SignupOutcome =
  | { emailed: true; result: SendResult }
  | { emailed: false; skip: SendSkip };

/** Stores a pending signup and sends its confirmation email, unless a check stops it. */
export async function submitSignup(
  deps: SignupDeps,
  form: PublicForm,
  input: SubmitInput,
): Promise<SignupOutcome> {
  const { db, now } = deps;
  const row = form.row;
  const emailHash = await requireService(deps.services, "hashEmail")(input.email);
  const skip = await sendSkip(deps, row, input.email, emailHash);
  if (skip) return { emailed: false, skip };

  const token = newSignupToken();
  const tokenHash = await hashSignupToken(token);
  const values = {
    email: input.email,
    field_values: JSON.stringify(input.values),
    consent_version: row.consent_version,
    ip_hash: input.ipHash,
    user_agent: input.userAgent?.slice(0, 300) ?? null,
    token_hash: tokenHash,
    expires_at: now + SIGNUP_TOKEN_TTL_MS,
    resend_count: 0,
    sent_at: null,
    confirmed_at: null,
    deferred_origin: null,
    created_at: now,
  };
  await db.db
    .insertInto("signups")
    .values({ workspace_id: row.workspace_id, form_id: row.id, email_hash: emailHash, ...values })
    .onConflict((conflict) => conflict.columns(["form_id", "email_hash"]).doUpdateSet(values))
    .execute();
  const reservation = await reserveConfirmation(db, deps.services, row.workspace_id);
  if (!reservation) {
    await deferConfirmation(db, row.workspace_id, tokenHash, input.origin);
    return { emailed: true, result: "deferred" };
  }
  const result = await sendConfirmation(
    deps,
    row,
    form.workspaceName,
    input.email,
    `${input.origin}${confirmPath(token)}`,
    reservation,
  );
  if (result === "sent") {
    await db.db
      .updateTable("signups")
      .set({ sent_at: now })
      .where("workspace_id", "=", row.workspace_id)
      .where("token_hash", "=", tokenHash)
      .execute();
  }
  return { emailed: true, result };
}

// The signup of a token -----------------------------------------------------------------------------

export type SignupState =
  | { kind: "invalid" }
  | { kind: "ready" | "confirmed" | "expired"; signup: Row<"signups">; form: PublicForm };

/** The signup of a confirmation token and its state. A disabled form gives `invalid`. */
export async function signupOfToken(
  db: DbConnection,
  token: string,
  now: number,
): Promise<SignupState> {
  if (!SIGNUP_TOKEN_PATTERN.test(token)) return { kind: "invalid" };
  // The token is the credential. Its hash is unique over every workspace.
  const signup = await unscoped(db.db)
    .selectFrom("signups")
    .selectAll()
    .where("token_hash", "=", await hashSignupToken(token))
    .executeTakeFirst();
  if (!signup) return { kind: "invalid" };
  const row = await db.db
    .selectFrom("forms")
    .selectAll()
    .where("workspace_id", "=", signup.workspace_id)
    .where("id", "=", signup.form_id)
    .executeTakeFirst();
  if (row?.enabled !== 1) return { kind: "invalid" };
  const form = await publicFormOf(db, row);
  if (signup.confirmed_at !== null) return { kind: "confirmed", signup, form };
  if (signup.expires_at <= now) return { kind: "expired", signup, form };
  return { kind: "ready", signup, form };
}

export function canResend(signup: Row<"signups">): boolean {
  return signup.confirmed_at === null && signup.resend_count < MAX_SIGNUP_RESENDS;
}

export type ResendOutcome =
  | { kind: "invalid" | "confirmed" | "exhausted" }
  | ({ kind: "done" } & SignupOutcome);

/**
 * A new link for the signup of `token` (KTD7). The old token stops working. The Worker
 * route checks Turnstile first. The same checks and limits as a submission apply.
 */
export async function resendSignup(
  deps: SignupDeps,
  token: string,
  origin: string,
): Promise<ResendOutcome> {
  const { db, now } = deps;
  const state = await signupOfToken(db, token, now);
  if (state.kind === "invalid") return { kind: "invalid" };
  if (state.kind === "confirmed") return { kind: "confirmed" };
  const { signup, form } = state;
  if (!canResend(signup)) return { kind: "exhausted" };
  const skip = await sendSkip(deps, form.row, signup.email, signup.email_hash);
  if (skip) return { kind: "done", emailed: false, skip };
  const next = newSignupToken();
  const nextHash = await hashSignupToken(next);
  const updated = await db.db
    .updateTable("signups")
    .set({
      token_hash: nextHash,
      expires_at: now + SIGNUP_TOKEN_TTL_MS,
      resend_count: signup.resend_count + 1,
      sent_at: null,
    })
    .where("workspace_id", "=", signup.workspace_id)
    .where("id", "=", signup.id)
    .where("token_hash", "=", signup.token_hash)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return { kind: "invalid" };
  const reservation = await reserveConfirmation(db, deps.services, signup.workspace_id);
  if (!reservation) {
    await deferConfirmation(db, signup.workspace_id, nextHash, origin);
    return { kind: "done", emailed: true, result: "deferred" };
  }
  const result = await sendConfirmation(
    deps,
    form.row,
    form.workspaceName,
    signup.email,
    `${origin}${confirmPath(next)}`,
    reservation,
  );
  if (result === "sent") {
    await db.db
      .updateTable("signups")
      .set({ sent_at: now })
      .where("workspace_id", "=", signup.workspace_id)
      .where("token_hash", "=", nextHash)
      .execute();
  }
  return { kind: "done", emailed: true, result };
}

// The outbox of confirmation emails at the daily cap (U19) ------------------------------------

/** Puts the confirmation email of the signup in the outbox until the cap has room. */
async function deferConfirmation(
  db: DbConnection,
  workspaceId: number,
  tokenHash: string,
  origin: string,
): Promise<void> {
  await db.db
    .updateTable("signups")
    .set({ deferred_origin: origin, sent_at: null })
    .where("workspace_id", "=", workspaceId)
    .where("token_hash", "=", tokenHash)
    .execute();
}

/** How long a confirmation email can wait in the outbox. Older signups get none. */
export const DEFERRED_CONFIRMATION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * Sends the confirmation emails that wait for the daily cap, oldest first (U19). The
 * cron runs it each minute. Each email reserves from the counter. A workspace whose cap
 * has no room yet keeps its emails for a later run. Each email gets a new token and a new
 * expiry, so the link works for the full time after it arrives. Returns the emails sent.
 */
export async function sendDeferredConfirmations(
  deps: Pick<SignupDeps, "db" | "services" | "now">,
  limit = 20,
): Promise<number> {
  const { db, now } = deps;
  // A deployment-wide job, as the signup purge.
  const rows = await unscoped(db.db)
    .selectFrom("signups")
    .selectAll()
    .where("deferred_origin", "is not", null)
    .where("confirmed_at", "is", null)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
  const full = new Set<number>();
  let sent = 0;
  for (const signup of rows) {
    const workspaceId = signup.workspace_id;
    if (full.has(workspaceId)) continue;
    const clear = () =>
      db.db
        .updateTable("signups")
        .set({ deferred_origin: null })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", signup.id)
        .execute();
    const form = await db.db
      .selectFrom("forms")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", signup.form_id)
      .executeTakeFirst();
    if (
      form?.enabled !== 1 ||
      signup.created_at < now - DEFERRED_CONFIRMATION_MAX_AGE_MS ||
      (await isSuppressed(db, workspaceId, signup.email_hash))
    ) {
      await clear();
      continue;
    }
    const reservation = await reserveConfirmation(db, deps.services, workspaceId);
    if (!reservation) {
      full.add(workspaceId);
      continue;
    }
    const token = newSignupToken();
    const tokenHash = await hashSignupToken(token);
    const origin = signup.deferred_origin ?? "";
    const updated = await db.db
      .updateTable("signups")
      .set({ token_hash: tokenHash, expires_at: now + SIGNUP_TOKEN_TTL_MS, deferred_origin: null })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", signup.id)
      .where("token_hash", "=", signup.token_hash)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      await reservation.release();
      continue;
    }
    const workspace = await db.db
      .selectFrom("workspaces")
      .select("name")
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    const result = await sendConfirmation(
      deps,
      form,
      workspace?.name ?? "",
      signup.email,
      `${origin}${confirmPath(token)}`,
      reservation,
    );
    if (result === "sent") {
      sent++;
      await db.db
        .updateTable("signups")
        .set({ sent_at: now })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", signup.id)
        .execute();
    }
  }
  return sent;
}
