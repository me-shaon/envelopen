import { type DbConnection, isD1DailyLimitError, nextUtcMidnight, type Row } from "@envelopen/db";
import {
  mergeTagNames,
  personalize,
  prepareMessage,
  RESERVED_TAGS,
  STANDARD_FIELDS,
  type TokenSigner,
} from "@envelopen/email-render";
import { type FailureReason, MessageError, sendBatch } from "@envelopen/providers";
import { liveBrand } from "../brand/model";
import { customFieldValues } from "../campaigns/batch";
import type { DailyCounter } from "../connections/daily-cap";
import { adapterContext, adapterOf, decryptCredentials, refsOf } from "../connections/model";
import { checkCampaignPolicy, sendingConnection } from "../connections/policy-gate";
import type { Services } from "../services";
import { testLinkOrigin, verifiedTrackingDomain } from "../templates/preview";
import type { BudgetDecision } from "../usage/limits";
import { checkStepEligibility, type StopReason } from "./eligibility";
import { parseSteps, WELCOME_TOKEN_CAMPAIGN, type WelcomeJob, welcomeRecipientId } from "./model";

// One step of a welcome series for one contact (KTD8). The Workflow
// (apps/worker/src/workflows/welcome-workflow.ts) calls `planStep` for the delay, sleeps,
// then calls `runWelcomeStep` inside a step with retries:
//
// 1. Read the series and the step by position, so an edit applies to the steps that have
//    not run yet. No step at the position ends the series.
// 2. A `sent` row ends the step: a retry after the provider accepted the email sends
//    nothing. A `pending` row is a send whose result is unknown, so it counts as sent. A
//    `skipped` row means that the series stopped for the contact. A `failed` row goes on.
// 3. At the D1 daily limit, or past the reserved threshold of the day's writes (the
//    UsageMeter reserve, KTD9, U11), the step waits until after 00:00 UTC.
// 4. Read the contact again: the series is on, the contact is subscribed to the list and
//    did not unsubscribe, the address is not suppressed, and no unsubscribe waits in the
//    UnsubscribeLedger. Otherwise a `skipped` row records the stop.
// 5. With a daily cap on the connection (U19), reserve one message from the rolling
//    counter. When the cap has no room, the step waits until the counter frees one.
//    A refusal that sent nothing gives the reservation back.
// 6. Insert the row as `pending`, personalize with merge tags and both unsubscribe
//    headers, and send through the workspace connection.
// 7. `sent` with the provider message id. A provider refusal (rate limit, quota,
//    credits, credentials, or a server error) marks the row `failed` and throws, so the
//    Workflow retries with backoff. After the last retry, the row stays `failed` and the
//    series goes on with the next step. A message that the provider rejects as invalid
//    fails at once, with no retry.
//
// Welcome emails carry no open pixel and no tracked links. The stats pages report
// campaigns only, and a tracked link needs a campaign's link table.

export interface WelcomeStepDeps {
  db: DbConnection;
  /** `connectSocket` is the outbound TCP of SMTP connections (KTD12). */
  services: Pick<Services, "credentials" | "outboundFetch" | "hashEmail"> &
    Partial<Pick<Services, "connectSocket">>;
  signer: TokenSigner;
  /** The platform_limit flag and the ledger flag of the UsageMeter. */
  usage(): Promise<{ limited: boolean; unsubscribesPending: boolean }>;
  /** The contacts with an unsubscribe in the UnsubscribeLedger (KTD1). */
  pendingUnsubscribes(workspaceId: number, contactIds: readonly number[]): Promise<Set<number>>;
  /**
   * The reserved D1 budget for automation (KTD9): "defer" past 70% of the day's writes
   * on Workers Free. The Workflow asks the UsageMeter `reserve` check.
   */
  budget(workspaceId: number): Promise<BudgetDecision>;
  /** The rolling daily counter of capped connections (U19). Without it, no cap applies. */
  dailyCounter?: Pick<DailyCounter, "reserve" | "release">;
  now(): number;
}

export type StepPlan = { kind: "step"; delayMinutes: number } | { kind: "end" };

export type StepOutcome =
  | { kind: "sent"; sendId: number; uncertain: boolean }
  | { kind: "failed"; sendId: number | null; error: string }
  | { kind: "stopped"; reason: StopReason }
  | { kind: "defer"; until: number; reason: "platform_limit" | "budget" | "daily_cap" }
  | { kind: "end" };

/** A refusal that a retry of the step can fix. The Workflow retries the step with backoff. */
export class WelcomeRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WelcomeRetryError";
  }
}

/** Refusals that mean nothing went out and a later try can work. */
const RETRY_REASONS: ReadonlySet<FailureReason> = new Set([
  "rate_limited",
  "quota",
  "credits",
  "auth",
  "server_error",
  "timeout",
  "network",
]);

async function loadSeries(db: DbConnection, job: WelcomeJob) {
  return db.db
    .selectFrom("welcome_series")
    .selectAll()
    .where("workspace_id", "=", job.workspaceId)
    .where("id", "=", job.seriesId)
    .executeTakeFirst();
}

/** The delay before the step at `position`, read now. No series or no step ends the run. */
export async function planStep(
  db: DbConnection,
  job: WelcomeJob,
  position: number,
): Promise<StepPlan> {
  const series = await loadSeries(db, job);
  const step = series ? parseSteps(series.steps)[position - 1] : undefined;
  return step ? { kind: "step", delayMinutes: step.delayMinutes } : { kind: "end" };
}

function sendRow(db: DbConnection, job: WelcomeJob, position: number) {
  return db.db
    .selectFrom("welcome_sends")
    .select(["id", "status", "skip_reason"])
    .where("workspace_id", "=", job.workspaceId)
    .where("series_id", "=", job.seriesId)
    .where("position", "=", position)
    .where("contact_id", "=", job.contactId)
    .executeTakeFirst();
}

/** The outcome that an existing row gives, or null when the step must run. */
function outcomeOfRow(row: {
  id: number;
  status: string;
  skip_reason: string | null;
}): StepOutcome | null {
  if (row.status === "sent") return { kind: "sent", sendId: row.id, uncertain: false };
  // The provider may have accepted it (KTD8).
  if (row.status === "pending") return { kind: "sent", sendId: row.id, uncertain: true };
  if (row.status === "skipped") {
    return { kind: "stopped", reason: (row.skip_reason ?? "series_disabled") as StopReason };
  }
  return null;
}

/** Records the stop of the series for the contact, so a later start does not run it again. */
async function recordSkip(
  db: DbConnection,
  job: WelcomeJob,
  position: number,
  reason: StopReason,
  now: number,
): Promise<void> {
  // A contact that no longer exists has nothing to record, and its foreign key would fail.
  if (reason === "contact_missing" || reason === "series_missing") return;
  await db.db
    .insertInto("welcome_sends")
    .values({
      workspace_id: job.workspaceId,
      series_id: job.seriesId,
      position,
      contact_id: job.contactId,
      status: "skipped",
      skip_reason: reason,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["series_id", "position", "contact_id"])
        .doUpdateSet({ status: "skipped", skip_reason: reason, updated_at: now })
        .where("welcome_sends.status", "=", "failed"),
    )
    .execute();
}

function mailbox(name: string | null, email: string): string {
  const clean = name?.replaceAll(/["<>\r\n]/g, "").trim();
  return clean ? `${clean} <${email}>` : email;
}

/** The From mailbox: the series' address, or noreply@ the first verified sending domain. */
async function senderOf(db: DbConnection, series: Row<"welcome_series">) {
  const workspace = await db.db
    .selectFrom("workspaces")
    .select("name")
    .where("id", "=", series.workspace_id)
    .executeTakeFirst();
  const name = series.from_name ?? workspace?.name ?? null;
  if (series.from_email)
    return { mailbox: mailbox(name, series.from_email), email: series.from_email };
  const domain = await db.db
    .selectFrom("sending_domains")
    .select("domain")
    .where("workspace_id", "=", series.workspace_id)
    .where("verified_at", "is not", null)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!domain) return null;
  const email = `noreply@${domain.domain}`;
  return { mailbox: mailbox(name, email), email };
}

/** The https origin of the unsubscribe links: the verified tracking domain, else the saved one. */
async function linkOrigin(db: DbConnection, series: Row<"welcome_series">, fromEmail: string) {
  const row = await db.db
    .selectFrom("sending_domains")
    .select(["tracking_domain", "tracking_status"])
    .where("workspace_id", "=", series.workspace_id)
    .where("domain", "=", fromEmail.split("@")[1] ?? "")
    .executeTakeFirst();
  const tracking = verifiedTrackingDomain(row);
  if (tracking) return `https://${tracking}`;
  return series.link_origin ?? testLinkOrigin(undefined);
}

/** Merge fields that the content uses beyond the standard and reserved ones. */
function customKeys(...texts: string[]): string[] {
  const known = new Set<string>([...STANDARD_FIELDS, ...RESERVED_TAGS]);
  return [...new Set(mergeTagNames(texts.join(" ")))].filter(
    (name) => !known.has(name) && !name.startsWith("@"),
  );
}

async function markFailed(
  db: DbConnection,
  job: WelcomeJob,
  sendId: number,
  error: string,
  now: number,
) {
  await db.db
    .updateTable("welcome_sends")
    .set({ status: "failed", error: error.slice(0, 300), updated_at: now })
    .where("workspace_id", "=", job.workspaceId)
    .where("id", "=", sendId)
    .where("status", "=", "pending")
    .execute();
}

/** Records a failure before the provider call, on a new or a failed row. */
async function recordFailure(
  db: DbConnection,
  job: WelcomeJob,
  position: number,
  error: string,
  now: number,
): Promise<number | null> {
  const row = await db.db
    .insertInto("welcome_sends")
    .values({
      workspace_id: job.workspaceId,
      series_id: job.seriesId,
      position,
      contact_id: job.contactId,
      status: "failed",
      error: error.slice(0, 300),
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["series_id", "position", "contact_id"])
        .doUpdateSet({
          error: error.slice(0, 300),
          attempts: (eb) => eb("welcome_sends.attempts", "+", 1),
          updated_at: now,
        })
        .where("welcome_sends.status", "=", "failed"),
    )
    .returning("id")
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Claims the step: a new `pending` row, or a `failed` row moved back to `pending`.
 * Returns null when another run of the step has the row (a race of two attempts).
 */
async function claimStep(
  db: DbConnection,
  job: WelcomeJob,
  position: number,
  now: number,
): Promise<number | null> {
  const row = await db.db
    .insertInto("welcome_sends")
    .values({
      workspace_id: job.workspaceId,
      series_id: job.seriesId,
      position,
      contact_id: job.contactId,
      status: "pending",
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["series_id", "position", "contact_id"])
        .doUpdateSet({
          status: "pending",
          error: null,
          attempts: (eb) => eb("welcome_sends.attempts", "+", 1),
          updated_at: now,
        })
        .where("welcome_sends.status", "=", "failed"),
    )
    .returning("id")
    .executeTakeFirst();
  return row?.id ?? null;
}

/** One step for one contact. See the comment at the top of this file. */
export async function runWelcomeStep(
  deps: WelcomeStepDeps,
  job: WelcomeJob,
  position: number,
): Promise<StepOutcome> {
  try {
    return await stepWork(deps, job, position);
  } catch (error) {
    if (!isD1DailyLimitError(error)) throw error;
    return { kind: "defer", until: nextUtcMidnight(deps.now()), reason: "platform_limit" };
  }
}

async function stepWork(
  deps: WelcomeStepDeps,
  job: WelcomeJob,
  position: number,
): Promise<StepOutcome> {
  const { db } = deps;
  const series = await loadSeries(db, job);
  const step = series ? parseSteps(series.steps)[position - 1] : undefined;
  if (series && !step) return { kind: "end" };

  const existing = await sendRow(db, job, position);
  const done = existing ? outcomeOfRow(existing) : null;
  if (done) return done;

  const usage = await deps.usage();
  if (usage.limited) {
    return { kind: "defer", until: nextUtcMidnight(deps.now()), reason: "platform_limit" };
  }
  const eligible = await checkStepEligibility(
    {
      db,
      hashEmail: deps.services.hashEmail,
      unsubscribesPending: usage.unsubscribesPending,
      pendingUnsubscribes: deps.pendingUnsubscribes,
    },
    series,
    job,
  );
  if (!eligible.ok) {
    await recordSkip(db, job, position, eligible.reason, deps.now());
    return { kind: "stopped", reason: eligible.reason };
  }
  if (!series || !step) return { kind: "end" };
  if ((await deps.budget(job.workspaceId)) === "defer") {
    return { kind: "defer", until: nextUtcMidnight(deps.now()), reason: "budget" };
  }

  // Welcome email is marketing email to a list: the campaign policy gate applies.
  const policy = await checkCampaignPolicy(db, job.workspaceId);
  if (!policy.allowed) {
    await recordFailure(db, job, position, policy.message, deps.now());
    throw new WelcomeRetryError(policy.message);
  }
  const connection = await sendingConnection(db, job.workspaceId);
  const template = await db.db
    .selectFrom("templates")
    .select(["html", "text"])
    .where("workspace_id", "=", job.workspaceId)
    .where("id", "=", step.templateId)
    .executeTakeFirst();
  if (!template?.html) {
    const error = "The template of this step does not exist or has no content.";
    return {
      kind: "failed",
      sendId: await recordFailure(db, job, position, error, deps.now()),
      error,
    };
  }
  const sender = await senderOf(db, series);
  if (!connection || !sender) {
    const error = "Verify a sending domain before the welcome series can send.";
    await recordFailure(db, job, position, error, deps.now());
    throw new WelcomeRetryError(error);
  }

  // The daily cap (U19): one message from the counter that campaigns share.
  let reservedAt: number | null = null;
  if (connection.daily_cap !== null && deps.dailyCounter) {
    const grant = await deps.dailyCounter.reserve(connection.id, 1, connection.daily_cap);
    if (!grant.granted) {
      return {
        kind: "defer",
        until: grant.freeAt ?? deps.now() + 24 * 60 * 60 * 1000,
        reason: "daily_cap",
      };
    }
    reservedAt = grant.at;
  }
  const release = async () => {
    if (reservedAt !== null) await deps.dailyCounter?.release(connection.id, 1, reservedAt);
  };

  const sendId = await claimStep(db, job, position, deps.now());
  if (sendId === null) {
    await release();
    const again = await sendRow(db, job, position);
    return (
      (again && outcomeOfRow(again)) ?? { kind: "sent", sendId: again?.id ?? 0, uncertain: true }
    );
  }

  const contact = eligible.contact;
  const keys = customKeys(step.subject, template.html, template.text ?? "");
  const custom = await customFieldValues(db, job.workspaceId, [contact.id], keys);
  const origin = await linkOrigin(db, series, sender.email);
  const prepared = prepareMessage({
    html: template.html,
    subject: step.subject,
    text: template.text,
    trackingOrigin: origin,
    trackOpens: false,
    trackClicks: false,
    // A welcome email uses the live brand at each send (U13, KTD10).
    brand: await liveBrand(db, job.workspaceId, origin),
  });
  const personal = await personalize(
    prepared,
    {
      campaignId: WELCOME_TOKEN_CAMPAIGN,
      recipientId: welcomeRecipientId(sendId),
      fields: {
        ...Object.fromEntries(keys.map((key) => [key, null])),
        ...custom.get(contact.id),
        email: contact.email,
        first_name: contact.firstName,
        last_name: contact.lastName,
      },
    },
    deps.signer,
  );

  let result: Awaited<ReturnType<typeof sendBatch>>;
  try {
    result = await sendBatch(
      adapterOf(connection),
      [
        {
          recipientId: String(sendId),
          kind: "campaign",
          from: sender.mailbox,
          to: contact.email,
          ...(series.reply_to ? { replyTo: series.reply_to } : {}),
          subject: personal.subject,
          html: personal.html,
          ...(personal.text ? { text: personal.text } : {}),
          headers: personal.headers,
        },
      ],
      await decryptCredentials(deps.services, connection),
      adapterContext(deps.services, refsOf(connection)),
    );
  } catch (error) {
    // A message that breaks the contract never reached the provider.
    if (!(error instanceof MessageError)) throw error;
    await release();
    await markFailed(db, job, sendId, error.message, deps.now());
    return { kind: "failed", sendId, error: error.message };
  }

  const item = result.results[0];
  if (item?.outcome === "sent") {
    await db.db
      .updateTable("welcome_sends")
      .set({
        status: "sent",
        provider_message_id: item.providerMessageId ?? null,
        error: null,
        sent_at: deps.now(),
        updated_at: deps.now(),
      })
      .where("workspace_id", "=", job.workspaceId)
      .where("id", "=", sendId)
      .execute();
    return { kind: "sent", sendId, uncertain: false };
  }
  // The provider may have accepted it. The row stays pending, and a retry treats it as sent.
  if (!item || item.outcome === "unknown") return { kind: "sent", sendId, uncertain: true };
  const error =
    item.message ?? result.failure?.message ?? item.reason ?? "The provider refused the email.";
  await markFailed(db, job, sendId, error, deps.now());
  if (item.reason && RETRY_REASONS.has(item.reason)) {
    await release();
    throw new WelcomeRetryError(error);
  }
  return { kind: "failed", sendId, error };
}
