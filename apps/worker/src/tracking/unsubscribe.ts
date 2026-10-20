import {
  loadSubscription,
  resubscribe,
  type Subscription,
  savePreferences,
  type TrackingEvent,
  unsubscribeAll,
} from "@envelopen/core";
import { type Context, Hono } from "hono";
import { readBodyLimited } from "../body";
import { isSameOriginPost, sameToken } from "./csrf";
import { type TrackingDeps, type TrackingDepsFactory, trackingDeps } from "./deps";
import { type PageNotice, pageResponse } from "./preferences";

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
// An invalid, forged, or unknown token gets one generic page with status 404 and
// changes nothing. The test link `/u/test` of test sends lands there too.

const MAX_FORM_BYTES = 16 * 1024;
const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i;

export interface UnsubscribeRoutesOptions {
  deps?: TrackingDepsFactory;
}

type AppContext = Context<{ Bindings: Env }>;

function preferencesPath(token: string): string {
  return `/u/${encodeURIComponent(token)}/preferences`;
}

async function verifiedSubscription(
  deps: TrackingDeps,
  token: string,
): Promise<Subscription | null> {
  const verified = await (await deps.signer()).verify(token);
  if (!verified) return null;
  return loadSubscription(deps.db, verified);
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

export function createUnsubscribeRoutes(options: UnsubscribeRoutesOptions = {}) {
  const makeDeps = options.deps ?? trackingDeps;
  const app = new Hono<{ Bindings: Env }>();

  async function show(c: AppContext) {
    const deps = makeDeps(c.env);
    const token = c.req.param("token") ?? "";
    try {
      const sub = await verifiedSubscription(deps, token);
      if (!sub) return pageResponse({ kind: "invalid" }, 404);
      const action = preferencesPath(token);
      const csrf = await deps.formToken(token);
      const state = c.req.query("state");
      if (sub.unsubscribedAt !== null) {
        return pageResponse({
          kind: "unsubscribed",
          sub,
          csrf,
          action,
          already: state !== "unsubscribed",
        });
      }
      if (c.req.query("step") === "confirm-all") {
        return pageResponse({ kind: "confirm_all", sub, csrf, action, backHref: action });
      }
      const notice: PageNotice = state === "saved" || state === "resubscribed" ? state : null;
      return pageResponse({
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
        return pageResponse({ kind: "invalid" }, 400);
      }
      const sub = await verifiedSubscription(deps, c.req.param("token"));
      if (!sub) return pageResponse({ kind: "invalid" }, 404);
      const now = deps.now();
      let changed: boolean;
      try {
        changed = await unsubscribeAll(deps.db, sub, "one_click", now);
      } catch (error) {
        console.error("One-click unsubscribe failed", error);
        return pageResponse({ kind: "error" }, 503);
      }
      if (changed) background(c, deps.sink(sub.workspaceId, [unsubscribeEvent(sub, now)]));
      return pageResponse({ kind: "one_click_done" });
    } finally {
      background(c, deps.db.meter.flush());
    }
  });

  // The preference page's forms.
  app.post("/:token/preferences", async (c) => {
    const deps = makeDeps(c.env);
    const token = c.req.param("token");
    try {
      if (!isSameOriginPost(c.req.raw)) return pageResponse({ kind: "invalid" }, 403);
      const form = await readForm(c);
      if (!form) return pageResponse({ kind: "invalid" }, 400);
      const sub = await verifiedSubscription(deps, token);
      if (!sub) return pageResponse({ kind: "invalid" }, 404);
      if (!sameToken(text(form.csrf), await deps.formToken(token))) {
        return pageResponse({ kind: "invalid" }, 403);
      }
      const action = text(form.action);
      const now = deps.now();
      const back = preferencesPath(token);
      try {
        if (action === "unsubscribe_all") {
          if (await unsubscribeAll(deps.db, sub, "preference_page", now)) {
            background(c, deps.sink(sub.workspaceId, [unsubscribeEvent(sub, now)]));
          }
          return c.redirect(`${back}?state=unsubscribed`, 303);
        }
        if (action === "resubscribe") {
          await resubscribe(deps.db, sub, now);
          return c.redirect(`${back}?state=resubscribed`, 303);
        }
        if (action === "save") {
          const raw = form.list;
          const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
          const ids = new Set(
            values
              .map((value) => Number(text(value)))
              .filter((value) => Number.isSafeInteger(value) && value > 0),
          );
          const result = await savePreferences(deps.db, sub, ids, now);
          if (result.unsubscribed > 0) {
            background(c, deps.sink(sub.workspaceId, [unsubscribeEvent(sub, now)]));
          }
          return c.redirect(`${back}?state=saved`, 303);
        }
      } catch (error) {
        console.error("Preference change failed", error);
        return pageResponse({ kind: "error" }, 503);
      }
      return pageResponse({ kind: "invalid" }, 400);
    } finally {
      background(c, deps.db.meter.flush());
    }
  });

  app.all("*", () => pageResponse({ kind: "invalid" }, 404));
  return app;
}
