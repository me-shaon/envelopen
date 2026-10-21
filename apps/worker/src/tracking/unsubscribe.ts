import {
  loadSubscription,
  preferenceAnswers,
  resubscribe,
  type Subscription,
  savePreferences,
  stopWelcome,
  type TrackingEvent,
  type UnsubscribeSource,
  unsubscribeAll,
} from "@envelopen/core";
import { isD1DailyLimitError } from "@envelopen/db";
import type { VerifiedToken } from "@envelopen/email-render";
import { fieldInputName } from "@envelopen/email-render/form-page";
import { type Context, Hono } from "hono";
import { clientIp } from "../auth/rate-limit-do";
import { readBodyLimited } from "../body";
import { type IntentInput, settleUnsubscribes } from "../do/unsubscribes";
import { isSameOriginPost, sameToken } from "./csrf";
import { type TrackingDeps, type TrackingDepsFactory, trackingDeps } from "./deps";
import { type PageNotice, publicPage } from "./preferences";

// Unsubscribe and the preference page (R24, R25, R64, KTD30, F3, AE5). Routes under /u:
//
//   GET  /u/<token>               the preference page. It never unsubscribes.
//   GET  /u/<token>/preferences   the same page. `?step=confirm-all` shows the
//                                 "unsubscribe from all" confirmation.
//   POST /u/<token>               RFC 8058 one-click: the body `List-Unsubscribe=One-Click`
//                                 as application/x-www-form-urlencoded or
//                                 multipart/form-data. Unsubscribes at once and answers
//                                 200 with a short page, never a redirect.
//   POST /u/<token>/preferences   the page's forms: save, unsubscribe_all, resubscribe.
//                                 They need the form token and a same-origin browser,
//                                 and answer with a 303 redirect to the page.
//
// The change is written to D1 before the response (R25: immediately). The raw
// `unsubscribe` event and its rollup go through the EventBuffer afterwards.
//
// At the D1 daily limit (KTD1, AE1), D1 rejects the read or the write. The routes then
// keep the unsubscribe in the UnsubscribeLedger and answer as if D1 had it:
// - The one-click POST and "unsubscribe from all" keep an intent for every list. When
//   the read failed, the intent has only the recipient of the verified token.
// - A save keeps an intent for each list that the subscriber cleared. The form lists
//   the lists that it showed (`shown`), so this needs no D1 read.
// - A save that changes a custom field answer (R14) keeps no field change: only an
//   unsubscribe is critical for compliance. The page then says that the answers were
//   not saved, and asks the subscriber to try again later. When the read failed, the
//   page cannot compare, so any field that the form showed (`field_shown`) counts.
// - The page GET shows a short page that offers only "Unsubscribe from all".
// - A resubscribe needs D1, so it shows the error page.
// Ledger writes are limited per IP. A full ledger or another D1 error shows the error
// page with status 503. While D1 works, the page first writes the waiting intents of
// its contact to D1 (`settleUnsubscribes`), so it shows the real state.
//
// An invalid, forged, or unknown token gets one generic page with status 404 and
// changes nothing. The test link `/u/test` of test sends lands there too.
//
// After an unsubscribe that D1 has, the welcome series instances of the contact stop in
// the background (U10, KTD8): every series for an unsubscribe from all, and the series of
// the lists that a save left. An intent in the ledger stops nothing here: each welcome
// step checks the ledger before it sends.

const MAX_FORM_BYTES = 16 * 1024;
const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i;

export interface UnsubscribeRoutesOptions {
  deps?: TrackingDepsFactory;
}

type AppContext = Context<{ Bindings: Env }>;

function preferencesPath(token: string): string {
  return `/u/${encodeURIComponent(token)}/preferences`;
}

type Loaded =
  | { kind: "ok"; ref: VerifiedToken; sub: Subscription }
  | { kind: "limited"; ref: VerifiedToken }
  | { kind: "invalid" }
  | { kind: "error" };

async function verifiedToken(deps: TrackingDeps, token: string): Promise<VerifiedToken | null> {
  return (await deps.signer()).verify(token);
}

/** The contact of a verified token. D1 reads it, so it can meet the daily limit. */
async function loadVerified(deps: TrackingDeps, ref: VerifiedToken | null): Promise<Loaded> {
  if (!ref) return { kind: "invalid" };
  try {
    const sub = await loadSubscription(deps.db, ref);
    return sub ? { kind: "ok", ref, sub } : { kind: "invalid" };
  } catch (error) {
    if (isD1DailyLimitError(error)) return { kind: "limited", ref };
    console.error("Subscription lookup failed", error);
    return { kind: "error" };
  }
}

/**
 * Writes the waiting ledger intents of the contact to D1, then reads the contact again.
 * A ledger error leaves the page as D1 has it.
 */
async function settled(deps: TrackingDeps, loaded: Loaded): Promise<Loaded> {
  if (loaded.kind !== "ok") return loaded;
  const { sub, ref } = loaded;
  try {
    const changed = await settleUnsubscribes(
      deps.db,
      deps.ledger,
      deps.sink,
      { workspaceId: sub.workspaceId, contactId: sub.contactId, recipientId: sub.recipientId },
      deps.now(),
    );
    return changed ? loadVerified(deps, ref) : loaded;
  } catch (error) {
    if (isD1DailyLimitError(error)) return { kind: "limited", ref };
    console.error("Unsubscribe ledger check failed", error);
    return loaded;
  }
}

/** One intent per list in `listIds`, or one for every list when it is null. */
function intents(
  ref: VerifiedToken,
  sub: Subscription | null,
  listIds: readonly number[] | null,
  source: UnsubscribeSource,
  at: number,
): IntentInput[] {
  const base = {
    campaignId: ref.campaignId,
    recipientId: ref.recipientId,
    workspaceId: sub?.workspaceId ?? null,
    contactId: sub?.contactId ?? null,
    source,
    at,
  };
  if (listIds === null) return [{ ...base, listId: null }];
  return listIds.map((listId) => ({ ...base, listId }));
}

/** Keeps the intents in the UnsubscribeLedger. False when they were not stored. */
async function keep(c: AppContext, deps: TrackingDeps, list: IntentInput[]): Promise<boolean> {
  if (list.length === 0) return true;
  try {
    if (!(await deps.allowLedgerWrite(clientIp(c.req.raw)))) {
      console.error("Unsubscribe ledger write refused: too many requests from one IP");
      return false;
    }
    return (await deps.ledger.record(list)).stored;
  } catch (error) {
    console.error("Unsubscribe ledger write failed", error);
    return false;
  }
}

function unsubscribeEvent(sub: Subscription, now: number): TrackingEvent {
  return {
    source: "tracking",
    type: "unsubscribe",
    campaignId: sub.campaignId,
    recipientId: sub.recipientId,
    contactId: sub.contactId,
    linkId: null,
    machine: false,
    bot: false,
    reason: null,
    occurredAt: now,
  };
}

/** Stops the contact's welcome series: of `listIds`, or every series when it is null. */
function stopSeries(
  c: AppContext,
  deps: TrackingDeps,
  sub: Subscription,
  listIds: readonly number[] | null,
): void {
  background(c, stopWelcome(deps.db, deps.welcome, sub.workspaceId, [sub.contactId], listIds));
}

function background(c: AppContext, work: Promise<unknown>): void {
  c.executionCtx.waitUntil(
    work.then(
      () => undefined,
      (error) => console.error("Background work failed", error),
    ),
  );
}

async function readForm(
  c: AppContext,
): Promise<Record<string, string | File | (string | File)[]> | null> {
  const type = c.req.header("content-type") ?? "";
  if (!FORM_TYPES.test(type)) return null;
  // Counted while reading, so a chunked body without Content-Length is capped too.
  const bytes = await readBodyLimited(c.req.raw, MAX_FORM_BYTES);
  if (!bytes) return null;
  try {
    const form = await new Request(c.req.url, {
      method: "POST",
      headers: { "content-type": type },
      body: bytes,
    }).formData();
    const fields: Record<string, string | File | (string | File)[]> = {};
    for (const [name, value] of form) {
      const previous = fields[name];
      if (previous === undefined) fields[name] = value;
      else fields[name] = Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    return fields;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  if (Array.isArray(value)) return text(value[0]);
  return typeof value === "string" ? value : "";
}

/** The text values of a form field. */
function texts(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values.map((value) => text(value));
}

/** The positive list ids in a form field. */
function listIds(raw: unknown): Set<number> {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return new Set(
    values
      .map((value) => Number(text(value)))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
}

export function createUnsubscribeRoutes(options: UnsubscribeRoutesOptions = {}) {
  const makeDeps = options.deps ?? trackingDeps;
  const app = new Hono<{ Bindings: Env }>();

  async function show(c: AppContext) {
    const deps = makeDeps(c.env);
    const token = c.req.param("token") ?? "";
    try {
      const loaded = await settled(
        deps,
        await loadVerified(deps, await verifiedToken(deps, token)),
      );
      if (loaded.kind === "invalid") return publicPage(deps, { kind: "invalid" }, 404);
      if (loaded.kind === "error") return publicPage(deps, { kind: "error" }, 503);
      const action = preferencesPath(token);
      const csrf = await deps.formToken(token);
      const state = c.req.query("state");
      if (loaded.kind === "limited") {
        const waiting = await deps.ledger
          .find({ recipientId: loaded.ref.recipientId })
          .catch(() => []);
        return publicPage(deps, {
          kind: "limited",
          csrf,
          action,
          unsubscribed: waiting.some((intent) => intent.listId === null),
          notice: state === "saved" || state === "retry" ? state : null,
        });
      }
      const { sub } = loaded;
      if (sub.unsubscribedAt !== null) {
        return publicPage(deps, {
          kind: "unsubscribed",
          sub,
          csrf,
          action,
          already: state !== "unsubscribed",
        });
      }
      if (c.req.query("step") === "confirm-all") {
        return publicPage(deps, { kind: "confirm_all", sub, csrf, action, backHref: action });
      }
      const notice: PageNotice =
        state === "saved" || state === "resubscribed" || state === "retry" ? state : null;
      return publicPage(deps, {
        kind: "preferences",
        sub,
        csrf,
        action,
        confirmHref: `${action}?step=confirm-all`,
        notice,
      });
    } finally {
      background(c, deps.db.meter.flush());
    }
  }

  app.get("/:token", show);
  app.get("/:token/preferences", show);

  // RFC 8058 one-click. A mail provider's server sends it: no cookies, no redirect.
  app.post("/:token", async (c) => {
    const deps = makeDeps(c.env);
    try {
      const form = await readForm(c);
      if (!form || text(form["List-Unsubscribe"]) !== "One-Click") {
        return publicPage(deps, { kind: "invalid" }, 400);
      }
      // The signature first: an invalid token never reaches D1 or the ledger.
      const loaded = await loadVerified(deps, await verifiedToken(deps, c.req.param("token")));
      if (loaded.kind === "invalid") return publicPage(deps, { kind: "invalid" }, 404);
      if (loaded.kind === "error") return publicPage(deps, { kind: "error" }, 503);
      const now = deps.now();
      if (loaded.kind === "limited") {
        const kept = await keep(c, deps, intents(loaded.ref, null, null, "one_click", now));
        return kept
          ? publicPage(deps, { kind: "one_click_done" })
          : publicPage(deps, { kind: "error" }, 503);
      }
      const { sub, ref } = loaded;
      let changed: boolean;
      try {
        changed = await unsubscribeAll(deps.db, sub, "one_click", now);
      } catch (error) {
        if (
          isD1DailyLimitError(error) &&
          (await keep(c, deps, intents(ref, sub, null, "one_click", now)))
        ) {
          return publicPage(deps, { kind: "one_click_done" });
        }
        console.error("One-click unsubscribe failed", error);
        return publicPage(deps, { kind: "error" }, 503);
      }
      if (changed) {
        background(c, deps.sink(sub.workspaceId, [unsubscribeEvent(sub, now)]));
        stopSeries(c, deps, sub, null);
      }
      return publicPage(deps, { kind: "one_click_done" });
    } finally {
      background(c, deps.db.meter.flush());
    }
  });

  // The preference page's forms.
  app.post("/:token/preferences", async (c) => {
    const deps = makeDeps(c.env);
    const token = c.req.param("token");
    try {
      if (!isSameOriginPost(c.req.raw)) return publicPage(deps, { kind: "invalid" }, 403);
      const form = await readForm(c);
      if (!form) return publicPage(deps, { kind: "invalid" }, 400);
      const ref = await verifiedToken(deps, token);
      if (!ref) return publicPage(deps, { kind: "invalid" }, 404);
      if (!sameToken(text(form.csrf), await deps.formToken(token))) {
        return publicPage(deps, { kind: "invalid" }, 403);
      }
      const loaded = await settled(deps, await loadVerified(deps, ref));
      if (loaded.kind === "invalid") return publicPage(deps, { kind: "invalid" }, 404);
      if (loaded.kind === "error") return publicPage(deps, { kind: "error" }, 503);
      const action = text(form.action);
      const now = deps.now();
      const back = preferencesPath(token);
      const checked = listIds(form.list);
      const sub = loaded.kind === "ok" ? loaded.sub : null;
      const shownFields = new Set(texts(form.field_shown));
      const rawFields = Object.fromEntries(
        (sub?.fields ?? []).map((field) => [field.key, texts(form[fieldInputName(field.key)])]),
      );
      const answers =
        sub && action === "save" ? preferenceAnswers(sub.fields, rawFields, shownFields) : null;
      // An answer that changes a field. Without the contact, any shown field counts.
      const fieldChange = answers ? answers.ok && answers.changes.size > 0 : shownFields.size > 0;

      // At the daily limit: keep the unsubscribes in the ledger (KTD1).
      const atLimit = async () => {
        if (action === "unsubscribe_all") {
          if (await keep(c, deps, intents(ref, sub, null, "preference_page", now))) {
            return c.redirect(`${back}?state=unsubscribed`, 303);
          }
        } else if (action === "save") {
          const leave = sub
            ? sub.lists
                .filter((list) => list.status === "subscribed" && !checked.has(list.id))
                .map((list) => list.id)
            : [...listIds(form.shown)].filter((id) => !checked.has(id));
          if (await keep(c, deps, intents(ref, sub, leave, "preference_page", now))) {
            return c.redirect(`${back}?state=${fieldChange ? "retry" : "saved"}`, 303);
          }
        }
        return publicPage(deps, { kind: "error" }, 503);
      };

      if (!sub) {
        if (action !== "unsubscribe_all" && action !== "save" && action !== "resubscribe") {
          return publicPage(deps, { kind: "invalid" }, 400);
        }
        return atLimit();
      }
      if (answers && !answers.ok) {
        return publicPage(
          deps,
          {
            kind: "preferences",
            sub,
            csrf: await deps.formToken(token),
            action: back,
            confirmHref: `${back}?step=confirm-all`,
            notice: null,
            errors: answers.errors,
            values: { lists: checked, fields: rawFields },
          },
          400,
        );
      }
      try {
        if (action === "unsubscribe_all") {
          if (await unsubscribeAll(deps.db, sub, "preference_page", now)) {
            background(c, deps.sink(sub.workspaceId, [unsubscribeEvent(sub, now)]));
            stopSeries(c, deps, sub, null);
          }
          return c.redirect(`${back}?state=unsubscribed`, 303);
        }
        if (action === "resubscribe") {
          await resubscribe(deps.db, sub, now);
          return c.redirect(`${back}?state=resubscribed`, 303);
        }
        if (action === "save") {
          const changes = answers?.ok ? answers.changes : new Map<number, string | null>();
          const result = await savePreferences(deps.db, sub, checked, now, changes);
          if (result.unsubscribed > 0) {
            background(c, deps.sink(sub.workspaceId, [unsubscribeEvent(sub, now)]));
            stopSeries(
              c,
              deps,
              sub,
              sub.lists
                .filter((list) => list.status === "subscribed" && !checked.has(list.id))
                .map((list) => list.id),
            );
          }
          return c.redirect(`${back}?state=saved`, 303);
        }
      } catch (error) {
        if (isD1DailyLimitError(error)) return atLimit();
        console.error("Preference change failed", error);
        return publicPage(deps, { kind: "error" }, 503);
      }
      return publicPage(deps, { kind: "invalid" }, 400);
    } finally {
      background(c, deps.db.meter.flush());
    }
  });

  app.all("*", (c) => publicPage(makeDeps(c.env), { kind: "invalid" }, 404));
  return app;
}
