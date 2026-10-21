import {
  canResend,
  confirmSignup,
  loadPublicForm,
  type PublicForm,
  type RawSubmission,
  resendSignup,
  type SignupDeps,
  signupOfToken,
  submitSignup,
  textList,
  validateSubmission,
} from "@envelopen/core";
import { isD1DailyLimitError } from "@envelopen/db";
import {
  FORM_COPY,
  type FormPageValues,
  type FormPageView,
  fieldInputName,
  TURNSTILE_ACTIONS,
} from "@envelopen/email-render/form-page";
import { type Context, Hono } from "hono";
import { clientIp } from "../auth/rate-limit-do";
import { readBodyLimited } from "../body";
import { isSameOriginPost } from "../tracking/csrf";
import { FORM_IP_RULE, type FormDeps, type FormDepsFactory, formDeps } from "./deps";
import { formPageResponse } from "./page";

// Public signup form routes (U8, R10, R11, KTD6, KTD7, F1). Under /f:
//
//   GET  /f/<publicId>                 the hosted form. `?embed=1` in the iframe snippet.
//   POST /f/<publicId>                 a submission: IP limit, values, Turnstile, then the
//                                      same "check your inbox" page for every address.
//   GET  /f/confirm/<token>            the confirm page with a Confirm button. A GET never
//                                      confirms, so a mail scanner cannot.
//   POST /f/confirm/<token>            the Confirm button.
//   POST /f/confirm/<token>/resend     a new link for an expired one. It needs Turnstile.
//
// The signup work after a valid submission runs after the response (`waitUntil`), so the
// response time does not show whether an email went out. Every POST must come from a page
// of this origin (`Sec-Fetch-Site`). The embedded form is an iframe of the hosted page, so
// its POST is same-origin too, and no CORS is needed.

const MAX_FORM_BYTES = 32 * 1024;
const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i;
const NOT_SET_UP = "This form is not set up yet. Try again later.";

type AppContext = Context<{ Bindings: Env }>;

export interface FormRoutesOptions {
  deps?: FormDepsFactory;
}

async function readForm(c: AppContext): Promise<Map<string, string[]> | null> {
  const type = c.req.header("content-type") ?? "";
  if (!FORM_TYPES.test(type)) return null;
  const bytes = await readBodyLimited(c.req.raw, MAX_FORM_BYTES);
  if (!bytes) return null;
  try {
    const form = await new Request(c.req.url, {
      method: "POST",
      headers: { "content-type": type },
      body: bytes,
    }).formData();
    const fields = new Map<string, string[]>();
    for (const [name, value] of form) {
      if (typeof value !== "string") continue;
      fields.set(name, [...(fields.get(name) ?? []), value]);
    }
    return fields;
  } catch {
    return null;
  }
}

function first(fields: Map<string, string[]>, name: string): string {
  return fields.get(name)?.[0] ?? "";
}

function signupDeps(deps: FormDeps): SignupDeps {
  return {
    db: deps.db,
    services: deps.services,
    now: deps.now(),
    limiter: deps.limiter,
    usage: deps.usage,
    pendingUnsubscribes: deps.pendingUnsubscribes,
  };
}

function background(c: AppContext, work: Promise<unknown>): void {
  c.executionCtx.waitUntil(
    work.then(
      () => undefined,
      (error) => console.error("Form background work failed", error),
    ),
  );
}

function rawSubmission(form: PublicForm, fields: Map<string, string[]>): RawSubmission {
  return {
    email: first(fields, "email"),
    fields: Object.fromEntries(
      form.defs.map((def) => [def.key, fields.get(fieldInputName(def.key)) ?? []]),
    ),
  };
}

function pageValues(raw: RawSubmission): FormPageValues {
  return { email: raw.email.slice(0, 254), fields: raw.fields };
}

export function createFormRoutes(options: FormRoutesOptions = {}) {
  const makeDeps = options.deps ?? formDeps;
  const app = new Hono<{ Bindings: Env }>();

  /** A page with the source link in the footer. */
  async function page(
    deps: FormDeps,
    view: FormPageView,
    extra: { ancestors?: readonly string[] | null; embed?: boolean; status?: number } = {},
  ): Promise<Response> {
    return formPageResponse(view, {
      sourceUrl: await deps.sourceUrl(),
      ancestors: extra.ancestors ?? null,
      embed: extra.embed ?? false,
      status: extra.status ?? 200,
    });
  }

  function flushLater(c: AppContext, deps: FormDeps) {
    background(c, deps.db.meter.flush());
  }

  // The hosted form ---------------------------------------------------------------------

  app.get("/confirm/:token", async (c) => {
    const deps = makeDeps(c.env, c.req.raw);
    try {
      const token = c.req.param("token");
      const state = await signupOfToken(deps.db, token, deps.now());
      const action = `/f/confirm/${token}`;
      switch (state.kind) {
        case "ready":
          return page(deps, { kind: "confirm", form: state.form.page, action });
        case "confirmed":
          return page(deps, { kind: "confirmed", form: state.form.page });
        case "expired":
          return page(deps, {
            kind: "expired",
            form: state.form.page,
            action: `${action}/resend`,
            siteKey: deps.turnstile?.siteKey ?? null,
            canResend: canResend(state.signup) && deps.turnstile !== null,
          });
        default:
          return page(deps, { kind: "invalid" }, { status: 404 });
      }
    } catch (error) {
      console.error("Confirm page failed", error);
      return page(deps, { kind: "unavailable" }, { status: 503 });
    } finally {
      flushLater(c, deps);
    }
  });

  app.post("/confirm/:token", async (c) => {
    const deps = makeDeps(c.env, c.req.raw);
    try {
      if (!isSameOriginPost(c.req.raw)) return page(deps, { kind: "invalid" }, { status: 403 });
      const token = c.req.param("token");
      const outcome = await confirmSignup(deps.db, token, deps.now());
      if (outcome.kind === "confirmed" && outcome.state.kind !== "invalid") {
        return page(deps, { kind: "confirmed", form: outcome.state.form.page });
      }
      if (outcome.kind === "expired") return c.redirect(`/f/confirm/${token}`, 303);
      return page(deps, { kind: "invalid" }, { status: 404 });
    } catch (error) {
      if (!isD1DailyLimitError(error)) console.error("Signup confirmation failed", error);
      return page(deps, { kind: "unavailable" }, { status: 503 });
    } finally {
      flushLater(c, deps);
    }
  });

  app.post("/confirm/:token/resend", async (c) => {
    const deps = makeDeps(c.env, c.req.raw);
    try {
      if (!isSameOriginPost(c.req.raw)) return page(deps, { kind: "invalid" }, { status: 403 });
      const token = c.req.param("token");
      const now = deps.now();
      const state = await signupOfToken(deps.db, token, now);
      if (state.kind === "invalid") return page(deps, { kind: "invalid" }, { status: 404 });
      if (state.kind === "confirmed") {
        return page(deps, { kind: "confirmed", form: state.form.page });
      }
      const expired = (error?: string, status = 200) =>
        page(
          deps,
          {
            kind: "expired",
            form: state.form.page,
            action: `/f/confirm/${token}/resend`,
            siteKey: deps.turnstile?.siteKey ?? null,
            canResend: canResend(state.signup) && deps.turnstile !== null,
            ...(error ? { error } : {}),
          },
          { status },
        );
      if (!deps.turnstile) return expired(NOT_SET_UP, 503);
      if (!canResend(state.signup)) return expired();
      const fields = await readForm(c);
      if (!fields) return expired(FORM_COPY.turnstileFailed, 400);
      const ip = clientIp(c.req.raw);
      const ipCount = await deps.limiter.record(`form-ip:${ip}`, FORM_IP_RULE);
      const inbox = () => page(deps, { kind: "inbox", form: state.form.page, backHref: null });
      if (ipCount.count > FORM_IP_RULE.limit) return inbox();
      const verified = await deps.verifyTurnstile({
        token: first(fields, "cf-turnstile-response"),
        ip,
        hostname: new URL(c.req.url).hostname,
        action: TURNSTILE_ACTIONS.resend,
      });
      if (!verified.ok) return expired(FORM_COPY.turnstileFailed, 400);
      const origin = new URL(c.req.url).origin;
      background(
        c,
        resendSignup(signupDeps(deps), token, origin).finally(() => deps.db.meter.flush()),
      );
      return inbox();
    } catch (error) {
      if (!isD1DailyLimitError(error)) console.error("Signup resend failed", error);
      return page(deps, { kind: "unavailable" }, { status: 503 });
    } finally {
      flushLater(c, deps);
    }
  });

  app.get("/:publicId", async (c) => {
    const deps = makeDeps(c.env, c.req.raw);
    const embed = c.req.query("embed") === "1";
    try {
      const form = await loadPublicForm(deps.db, c.req.param("publicId"));
      if (form?.row.enabled !== 1) {
        return page(deps, { kind: "unavailable" }, { status: 404, embed });
      }
      const ancestors = textList(form.row.allowed_origins);
      if (!deps.turnstile) {
        return page(
          deps,
          { kind: "unavailable", detail: NOT_SET_UP },
          { status: 503, embed, ancestors },
        );
      }
      return page(
        deps,
        {
          kind: "form",
          form: form.page,
          action: `/f/${form.row.public_id}${embed ? "?embed=1" : ""}`,
          siteKey: deps.turnstile.siteKey,
        },
        { embed, ancestors },
      );
    } catch (error) {
      console.error("Form page failed", error);
      return page(deps, { kind: "unavailable" }, { status: 503, embed });
    } finally {
      flushLater(c, deps);
    }
  });

  app.post("/:publicId", async (c) => {
    const deps = makeDeps(c.env, c.req.raw);
    const embed = c.req.query("embed") === "1";
    try {
      const form = await loadPublicForm(deps.db, c.req.param("publicId"));
      if (form?.row.enabled !== 1) {
        return page(deps, { kind: "unavailable" }, { status: 404, embed });
      }
      const ancestors = textList(form.row.allowed_origins);
      const show = (view: FormPageView, status = 200) =>
        page(deps, view, { status, embed, ancestors });
      if (!deps.turnstile) return show({ kind: "unavailable", detail: NOT_SET_UP }, 503);
      if (!isSameOriginPost(c.req.raw)) return show({ kind: "unavailable" }, 403);
      const fields = await readForm(c);
      if (!fields) return show({ kind: "unavailable" }, 400);
      const self = `/f/${form.row.public_id}${embed ? "?embed=1" : ""}`;
      const inbox = () => show({ kind: "inbox", form: form.page, backHref: self });

      // Too many submissions from one IP: the same page, and nothing else happens.
      const ip = clientIp(c.req.raw);
      const ipCount = await deps.limiter.record(`form-ip:${ip}`, FORM_IP_RULE);
      if (ipCount.count > FORM_IP_RULE.limit) return inbox();

      const raw = rawSubmission(form, fields);
      const formView = (errors: { target: string | null; message: string }[]) =>
        show(
          {
            kind: "form",
            form: form.page,
            action: self,
            siteKey: deps.turnstile?.siteKey ?? null,
            values: pageValues(raw),
            errors,
          },
          400,
        );
      const checked = validateSubmission(form.defs, raw);
      if (!checked.ok) return formView(checked.errors);
      const verified = await deps.verifyTurnstile({
        token: first(fields, "cf-turnstile-response"),
        ip,
        hostname: new URL(c.req.url).hostname,
        action: TURNSTILE_ACTIONS.signup,
      });
      if (!verified.ok) {
        return formView([{ target: null, message: FORM_COPY.turnstileFailed }]);
      }
      const origin = new URL(c.req.url).origin;
      const userAgent = c.req.header("user-agent") ?? null;
      background(
        c,
        (async () => {
          await submitSignup(signupDeps(deps), form, {
            email: checked.email,
            values: checked.values,
            ipHash: await deps.ipHash(ip),
            userAgent,
            origin,
          }).finally(() => deps.db.meter.flush());
        })(),
      );
      return inbox();
    } catch (error) {
      if (!isD1DailyLimitError(error)) console.error("Form submission failed", error);
      return page(deps, { kind: "unavailable" }, { status: 503, embed });
    } finally {
      flushLater(c, deps);
    }
  });

  app.all("*", async (c) => page(makeDeps(c.env, c.req.raw), { kind: "invalid" }, { status: 404 }));
  return app;
}
