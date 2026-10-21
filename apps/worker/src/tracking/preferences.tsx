/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import {
  type PreferenceField,
  preferenceFieldText,
  rawFieldValue,
  type Subscription,
} from "@envelopen/core";
import {
  type FormPageError,
  fieldInputId,
  fieldInputName,
} from "@envelopen/email-render/form-page";
import type { Child } from "hono/jsx";
import { ENVELOPEN_VERSION } from "../version";

// The public subscription pages (R24, KTD30): server-rendered Hono JSX with plain HTML
// forms, so they work without JavaScript and send no script at all. They follow the
// Calm look of the admin app (plan U5): a warm off-white page, a white card with a
// hairline border, black primary buttons, and the Geist type scale with system fallbacks.
//
// The page also shows the custom fields that the owner put on it (R14): a read-only
// field as text, an editable field as an input. Field labels and values come from the
// owner and the subscriber, so they render as escaped text only.
//
// States: the preference page, the "unsubscribe from all" confirmation, unsubscribed
// (just now, or already) with a resubscribe form, an invalid or forged link (one
// generic message), and an error when the change could not be saved.
//
// At the D1 daily limit, the page cannot read the contact. It then shows a short page
// that offers only "Unsubscribe from all", which the UnsubscribeLedger keeps (KTD1).
//
// The footer links to the source code of this deployment with the running version
// (AGPL section 13, KTD16). The owner sets the link in Settings. Hono JSX escapes it.
//
// Every response sends a strict Content-Security-Policy: no scripts, the one inline
// style block by nonce, and forms that post only to this origin (KTD27).

export type PageNotice = "saved" | "resubscribed" | "retry" | null;

/** The values of a save that failed the checks, so the page shows them again. */
export interface PageValues {
  lists: ReadonlySet<number>;
  fields: Readonly<Record<string, readonly string[]>>;
}

export type PageView =
  | { kind: "invalid" }
  | { kind: "link_invalid" }
  | { kind: "error" }
  | { kind: "one_click_done" }
  | {
      kind: "preferences";
      sub: Subscription;
      csrf: string;
      action: string;
      confirmHref: string;
      notice: PageNotice;
      /** Problems with the field answers of a save. Nothing was saved. */
      errors?: readonly FormPageError[];
      values?: PageValues;
    }
  | { kind: "confirm_all"; sub: Subscription; csrf: string; action: string; backHref: string }
  | {
      kind: "limited";
      csrf: string;
      action: string;
      /** True when the ledger holds an unsubscribe from all for this link. */
      unsubscribed: boolean;
      notice: PageNotice;
    }
  | {
      kind: "unsubscribed";
      sub: Subscription;
      csrf: string;
      action: string;
      /** True when the contact had unsubscribed before this visit. */
      already: boolean;
    };

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f8f7f4; --card: #ffffff; --fg: #1a1917; --muted: #6b675f; --border: #edebe6;
  --hairline: #f1efeb; --input: #e6e3dd; --primary: #1a1917; --primary-fg: #ffffff;
  --ring: #7b66c4; --notice: #e6efee; --notice-fg: #2e4b4a; --tone: #fbeadf; --tone-fg: #7a4614;
  --error: #fbe4e1; --error-fg: #8a2b1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141312; --card: #1a1917; --fg: #edebe6; --muted: #a39e94; --border: #2a2826;
    --hairline: #232220; --input: #3a3834; --primary: #edebe6; --primary-fg: #141312;
    --ring: #b3a3e6; --notice: #1f2e2d; --notice-fg: #b7d3d1; --tone: #3a2a20; --tone-fg: #f0c3a8;
    --error: #3a1f1b; --error-fg: #f2b8ae;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
  font: 14px/1.55 "Geist", "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; align-items: center; padding: 56px 16px 32px;
}
main { width: 100%; max-width: 480px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 32px; }
.eyebrow { margin: 0 0 10px; font-size: 12px; font-weight: 500; color: var(--muted); letter-spacing: 0.01em; }
h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 600; letter-spacing: -0.025em; }
p { margin: 10px 0 0; }
.muted { color: var(--muted); }
.email { font-weight: 500; overflow-wrap: anywhere; }
.notice { margin: 20px 0 0; padding: 10px 14px; border-radius: 10px; background: var(--notice); color: var(--notice-fg); font-size: 13px; }
.tone { background: var(--tone); color: var(--tone-fg); }
fieldset { margin: 24px 0 0; padding: 0; border: 0; }
legend { padding: 0; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.lists { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 10px; }
.lists li + li { border-top: 1px solid var(--hairline); }
.lists label { display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; }
.lists input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary); }
.field { margin-top: 16px; }
.field > label, .field > .label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.field fieldset { margin: 0; }
.value { margin: 0; overflow-wrap: anywhere; white-space: pre-line; }
input[type=text], input[type=number], input[type=date] {
  width: 100%; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--input);
  border-radius: 8px; padding: 8px 11px; min-height: 38px;
}
input[aria-invalid=true] { border-color: var(--error-fg); }
.choices { display: flex; flex-direction: column; gap: 6px; }
.choice { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.choice input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary); flex: none; }
.errors { margin: 20px 0 0; padding: 12px 14px; border-radius: 10px; background: var(--error); color: var(--error-fg); font-size: 13px; }
.errors h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0; }
.errors ul { margin: 6px 0 0; padding-left: 18px; }
.errors a { color: inherit; }
.errors:focus-visible, .errors a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.inline-error { margin: 6px 0 0; font-size: 12px; color: var(--error-fg); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; align-items: center; }
button, .button {
  font: inherit; font-weight: 500; font-size: 14px; line-height: 20px; border-radius: 8px;
  padding: 9px 16px; cursor: pointer; text-decoration: none; display: inline-block;
  border: 1px solid var(--primary); background: var(--primary); color: var(--primary-fg);
}
.secondary { background: transparent; color: var(--fg); border-color: var(--input); }
button:focus-visible, .button:focus-visible, input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
hr { border: 0; border-top: 1px solid var(--hairline); margin: 28px 0 0; }
h2 { margin: 24px 0 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
footer { margin-top: 20px; font-size: 12px; color: var(--muted); text-align: center; }
footer a { color: inherit; text-decoration: underline; text-decoration-color: var(--input); text-underline-offset: 3px; }
footer a:hover { color: var(--fg); }
footer a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 2px; }
@media (max-width: 480px) { body { padding-top: 24px; } .card { padding: 24px 20px; } }
`;

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(ms),
  );
}

function Layout({
  title,
  nonce,
  sourceUrl,
  children,
}: {
  title: string;
  nonce: string;
  sourceUrl: string;
  children: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="same-origin" />
        <title>{title}</title>
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main>
          <div class="card">{children}</div>
          <footer>
            Sent with Envelopen {ENVELOPEN_VERSION} ·{" "}
            <a href={sourceUrl} rel="noreferrer">
              Source code
            </a>
          </footer>
        </main>
      </body>
    </html>
  );
}

function Csrf({ value }: { value: string }) {
  return <input type="hidden" name="csrf" value={value} />;
}

function Resubscribe({ csrf, action }: { csrf: string; action: string }) {
  return (
    <form method="post" action={action}>
      <Csrf value={csrf} />
      <input type="hidden" name="action" value="resubscribe" />
      <h2>Unsubscribed by mistake?</h2>
      <p class="muted">Subscribe again to get the emails you had before.</p>
      <div class="actions">
        <button type="submit" class="secondary">
          Subscribe again
        </button>
      </div>
    </form>
  );
}

const RETRY_TEXT = "Your list choices are saved. Your answers were not saved. Try again later.";

function Notice({ notice }: { notice: PageNotice }) {
  if (notice === "saved") {
    return (
      <p class="notice" role="status">
        Your choices are saved.
      </p>
    );
  }
  if (notice === "resubscribed") {
    return (
      <p class="notice" role="status">
        You are subscribed again.
      </p>
    );
  }
  if (notice === "retry") {
    return (
      <p class="notice tone" role="status">
        {RETRY_TEXT}
      </p>
    );
  }
  return null;
}

function ErrorSummary({ errors }: { errors: readonly FormPageError[] }) {
  if (errors.length === 0) return null;
  // `autofocus` moves the focus to the summary without a script, so a screen reader
  // reads the problems first.
  return (
    <div
      class="errors"
      id="errors"
      role="alert"
      tabindex={-1}
      autofocus
      aria-labelledby="errors-title"
    >
      <h2 id="errors-title">Correct the problems below</h2>
      <ul>
        {errors.map((error) => (
          <li>{error.target ? <a href={`#${error.target}`}>{error.message}</a> : error.message}</li>
        ))}
      </ul>
    </div>
  );
}

function InlineError({ id, error }: { id: string; error: FormPageError | undefined }) {
  return error ? (
    <p class="inline-error" id={`${id}-error`}>
      {error.message}
    </p>
  ) : null;
}

/** A read-only field as text. */
function ReadOnlyField({ field }: { field: PreferenceField }) {
  const value = preferenceFieldText(field);
  return (
    <div class="field">
      <span class="label">{field.label}</span>
      <p class={value === null ? "value muted" : "value"}>{value ?? "Not set"}</p>
    </div>
  );
}

/** An editable field as an input, a group of radios, or a group of checkboxes. */
function EditableField({
  field,
  current,
  error,
}: {
  field: PreferenceField;
  current: readonly string[];
  error: FormPageError | undefined;
}) {
  const id = fieldInputId(field.key);
  const name = fieldInputName(field.key);
  const invalid = error
    ? { "aria-invalid": "true" as const, "aria-describedby": `${id}-error` }
    : {};
  if (field.kind !== null) {
    const type = field.kind === "choice" ? "radio" : "checkbox";
    return (
      <div class="field">
        <fieldset>
          <legend>{field.label}</legend>
          <div class="choices">
            {field.options.map((option, index) => (
              <label class="choice">
                <input
                  type={type}
                  id={index === 0 ? id : `${id}-${option.id}`}
                  name={name}
                  value={String(option.id)}
                  checked={current.includes(String(option.id))}
                  {...(index === 0 ? invalid : {})}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <InlineError id={id} error={error} />
        </fieldset>
      </div>
    );
  }
  if (field.type === "boolean") {
    return (
      <div class="field">
        <label class="choice">
          <input
            type="checkbox"
            id={id}
            name={name}
            value="true"
            checked={current.includes("true")}
            {...invalid}
          />
          <span>{field.label}</span>
        </label>
        <InlineError id={id} error={error} />
      </div>
    );
  }
  const type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
  return (
    <div class="field">
      <label for={id}>{field.label}</label>
      <input
        type={type}
        id={id}
        name={name}
        value={current[0] ?? ""}
        maxlength={1000}
        {...(field.type === "number" ? { step: "any", inputmode: "decimal" } : {})}
        {...invalid}
      />
      <InlineError id={id} error={error} />
    </div>
  );
}

function Preferences({ view }: { view: Extract<PageView, { kind: "preferences" }> }) {
  const { sub, csrf, action, confirmHref, notice, values } = view;
  const errors = view.errors ?? [];
  const editable = sub.fields.filter((field) => field.preference === "editable");
  const isChecked = (listId: number, status: string) =>
    values ? values.lists.has(listId) : status === "subscribed";
  const currentOf = (field: PreferenceField) => values?.fields[field.key] ?? rawFieldValue(field);
  const errorOf = (field: PreferenceField) =>
    errors.find((error) => error.target === fieldInputId(field.key));
  return (
    <>
      <p class="eyebrow">{sub.workspaceName}</p>
      <h1>Email preferences</h1>
      <p class="muted">
        Choose the emails that <span class="email">{sub.email}</span> gets from {sub.workspaceName}.
      </p>
      <Notice notice={notice} />
      <ErrorSummary errors={errors} />
      {sub.lists.length > 0 || editable.length > 0 ? (
        <form method="post" action={action} novalidate>
          <Csrf value={csrf} />
          <input type="hidden" name="action" value="save" />
          {sub.lists.map((list) => (
            <input type="hidden" name="shown" value={String(list.id)} />
          ))}
          {editable.map((field) => (
            <input type="hidden" name="field_shown" value={field.key} />
          ))}
          {sub.lists.length > 0 ? (
            <fieldset>
              <legend>Lists</legend>
              <ul class="lists">
                {sub.lists.map((list) => (
                  <li>
                    <label>
                      <input
                        type="checkbox"
                        name="list"
                        value={String(list.id)}
                        checked={isChecked(list.id, list.status)}
                      />
                      <span>{list.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
          {sub.fields.length > 0 ? (
            <section aria-labelledby="details-title">
              <h2 id="details-title">Your details</h2>
              {sub.fields.map((field) =>
                field.preference === "editable" ? (
                  <EditableField field={field} current={currentOf(field)} error={errorOf(field)} />
                ) : (
                  <ReadOnlyField field={field} />
                ),
              )}
            </section>
          ) : null}
          <div class="actions">
            <button type="submit">Save preferences</button>
          </div>
        </form>
      ) : sub.fields.length > 0 ? (
        <section aria-labelledby="details-title">
          <h2 id="details-title">Your details</h2>
          {sub.fields.map((field) => (
            <ReadOnlyField field={field} />
          ))}
        </section>
      ) : null}
      <hr />
      <h2>Unsubscribe from all</h2>
      <p class="muted">Stop every email from {sub.workspaceName}.</p>
      <div class="actions">
        <a class="button secondary" href={confirmHref}>
          Unsubscribe from all
        </a>
      </div>
    </>
  );
}

function ConfirmAll({ view }: { view: Extract<PageView, { kind: "confirm_all" }> }) {
  const { sub, csrf, action, backHref } = view;
  return (
    <>
      <p class="eyebrow">{sub.workspaceName}</p>
      <h1>Unsubscribe from all emails?</h1>
      <p class="muted">
        <span class="email">{sub.email}</span> will get no more emails from {sub.workspaceName}. You
        can subscribe again on this page.
      </p>
      <form method="post" action={action}>
        <Csrf value={csrf} />
        <input type="hidden" name="action" value="unsubscribe_all" />
        <div class="actions">
          <button type="submit">Unsubscribe from all</button>
          <a class="button secondary" href={backHref}>
            Cancel
          </a>
        </div>
      </form>
    </>
  );
}

function Unsubscribed({ view }: { view: Extract<PageView, { kind: "unsubscribed" }> }) {
  const { sub, csrf, action, already } = view;
  return (
    <>
      <p class="eyebrow">{sub.workspaceName}</p>
      <h1>{already ? "You are already unsubscribed" : "You are unsubscribed"}</h1>
      <p class="muted">
        <span class="email">{sub.email}</span>{" "}
        {already && sub.unsubscribedAt !== null
          ? `unsubscribed on ${formatDay(sub.unsubscribedAt)} and gets no emails from ${sub.workspaceName}.`
          : `will get no more emails from ${sub.workspaceName}.`}
      </p>
      <hr />
      <Resubscribe csrf={csrf} action={action} />
    </>
  );
}

function Limited({ view }: { view: Extract<PageView, { kind: "limited" }> }) {
  const { csrf, action, unsubscribed, notice } = view;
  if (unsubscribed) {
    return (
      <>
        <h1>You are unsubscribed</h1>
        <p class="muted">You will get no more emails from this sender.</p>
      </>
    );
  }
  return (
    <>
      <h1>Email preferences</h1>
      <p class="muted">
        Your list choices are not available now. You can still unsubscribe from all emails from this
        sender.
      </p>
      <Notice notice={notice} />
      <form method="post" action={action}>
        <Csrf value={csrf} />
        <input type="hidden" name="action" value="unsubscribe_all" />
        <div class="actions">
          <button type="submit">Unsubscribe from all</button>
        </div>
      </form>
    </>
  );
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p class="muted">{text}</p>
    </>
  );
}

function titleOf(view: PageView): string {
  switch (view.kind) {
    case "preferences":
      return "Email preferences";
    case "confirm_all":
      return "Unsubscribe from all emails";
    case "limited":
      return view.unsubscribed ? "Unsubscribed" : "Email preferences";
    case "unsubscribed":
    case "one_click_done":
      return "Unsubscribed";
    case "error":
      return "Something went wrong";
    default:
      return "Link not valid";
  }
}

function Body({ view }: { view: PageView }) {
  switch (view.kind) {
    case "preferences":
      return <Preferences view={view} />;
    case "confirm_all":
      return <ConfirmAll view={view} />;
    case "unsubscribed":
      return <Unsubscribed view={view} />;
    case "limited":
      return <Limited view={view} />;
    case "one_click_done":
      return (
        <Message
          title="You are unsubscribed"
          text="You will get no more emails from this sender."
        />
      );
    case "error":
      return (
        <Message
          title="Something went wrong"
          text="Your choice was not saved. Try again in a few minutes."
        />
      );
    case "link_invalid":
      return (
        <Message
          title="This link is not valid"
          text="The link may be incomplete or out of date. Open it again from the email, or copy the whole address."
        />
      );
    default:
      return (
        <Message
          title="This link is not valid"
          text="The link may be incomplete or out of date. To change your email settings, use the link in a recent email."
        />
      );
  }
}

/**
 * The page as a complete HTML document, and the nonce of its style block. `sourceUrl` is
 * the source link of the footer (TrackingDeps.sourceUrl).
 */
export async function renderPage(
  view: PageView,
  sourceUrl: string,
): Promise<{ html: string; nonce: string }> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const body = (
    <Layout title={titleOf(view)} nonce={nonce} sourceUrl={sourceUrl}>
      <Body view={view} />
    </Layout>
  );
  return { html: `<!doctype html>${await body.toString()}`, nonce };
}

/** The headers of every public page: strict CSP, no caching, no referrer to other sites, no indexing. */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "img-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "cache-control": "no-store",
    // The token is in the URL, so no other site gets it as a referrer.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  };
}

export async function pageResponse(
  view: PageView,
  sourceUrl: string,
  status = 200,
): Promise<Response> {
  const { html, nonce } = await renderPage(view, sourceUrl);
  return new Response(html, { status, headers: pageHeaders(nonce) });
}

/** A public page with the deployment's source link in the footer. */
export async function publicPage(
  deps: { sourceUrl(): Promise<string> },
  view: PageView,
  status = 200,
): Promise<Response> {
  return pageResponse(view, await deps.sourceUrl(), status);
}
