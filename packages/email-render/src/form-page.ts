// The public signup form page (U8, KTD6, R10, R11). One renderer for the hosted page that
// the Worker serves under /f/* and for the live preview in the admin form editor, so the
// preview shows exactly what a subscriber sees.
//
// The page is plain HTML with forms that post to the same origin. The only script is the
// Turnstile widget from challenges.cloudflare.com. Every text from the owner or the
// subscriber goes through `esc`, so it renders as plain text, never as markup.
//
// It follows the Calm look of the preference page (apps/worker/src/tracking/preferences.tsx):
// a warm off-white page, a white card with a hairline border, a black primary button, and
// the Geist type scale with system fallbacks. The layout is fluid. At a narrow width, the
// card loses its border and padding, so the page fits an iframe of 320 px and more.
//
// States: initial, submitting (the button label changes while the browser sends the form),
// validation error, Turnstile failure, check your inbox (also when rate-limited, so the
// page never tells whether an address is known), confirm ready, confirmed, link expired
// with resend, link not valid, and form not available.

export type FormFieldType = "text" | "number" | "date" | "boolean" | "choice" | "multi";

export interface FormPageField {
  key: string;
  label: string;
  type: FormFieldType;
  options: readonly { id: number; label: string }[];
}

export interface FormPageForm {
  name: string;
  consentText: string;
  successMessage: string;
  fields: readonly FormPageField[];
}

export interface FormPageError {
  /** The id of the input that the error belongs to, or null for the whole form. */
  target: string | null;
  message: string;
}

export interface FormPageValues {
  email: string;
  /** Raw values by field key: text, or the selected option ids. */
  fields: Readonly<Record<string, string | readonly string[]>>;
}

export type FormPageView =
  | {
      kind: "form";
      form: FormPageForm;
      action: string;
      /** The Turnstile site key. Null in the admin preview: no widget and no submit. */
      siteKey: string | null;
      values?: FormPageValues;
      errors?: readonly FormPageError[];
    }
  | { kind: "inbox"; form: FormPageForm; backHref: string | null }
  | { kind: "confirm"; form: FormPageForm; action: string }
  | { kind: "confirmed"; form: FormPageForm }
  | {
      kind: "expired";
      form: FormPageForm;
      action: string;
      siteKey: string | null;
      /** False when the signup has had every resend. */
      canResend: boolean;
      error?: string;
    }
  | { kind: "invalid" }
  | { kind: "unavailable"; detail?: string };

export interface FormPageLayout {
  /** The nonce of the one inline style block. */
  nonce: string;
  /** The source link of the footer (AGPL section 13, KTD16). */
  sourceUrl: string;
  version: string;
  /** In an iframe: a smaller top margin, so the form fits the recommended height. */
  embed?: boolean;
}

/** The Turnstile script. The page CSP allows scripts and frames from this host only. */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** The Turnstile actions that siteverify checks. */
export const TURNSTILE_ACTIONS = { signup: "signup", resend: "resend" } as const;

/** Copy of the page states (ASD-STE100). Tests and the admin app use the same text. */
export const FORM_COPY = {
  emailLabel: "Email address",
  submit: "Subscribe",
  submitting: "Sending",
  confirmNote: "We send you an email with a link. Select the link to confirm your subscription.",
  errorTitle: "Correct the problems below",
  emailInvalid: "Enter a valid email address, for example name@example.com.",
  numberInvalid: (label: string) => `Enter a number for ${label}.`,
  dateInvalid: (label: string) => `Enter a date for ${label}.`,
  optionInvalid: (label: string) => `Select an option from the list for ${label}.`,
  textTooLong: (label: string) => `Use 1,000 characters or fewer for ${label}.`,
  turnstileFailed:
    "We could not make sure that you are a person. Wait for the check to finish, then try again.",
  inboxTitle: "Check your inbox",
  inboxText:
    "If this address can get email from us, we sent it a link. Open the email and select the link to confirm your subscription. The link is valid for 72 hours.",
  inboxBack: "Use another address",
  confirmTitle: "Confirm your subscription",
  confirmText: "Select Confirm to start your subscription.",
  confirmButton: "Confirm",
  confirmedTitle: "You are subscribed",
  expiredTitle: "This link has expired",
  expiredText: "A confirmation link is valid for 72 hours. You can get a new link by email.",
  expiredNoMore:
    "You cannot get more links for this signup. Fill in the signup form again to get a new link.",
  resendButton: "Send a new link",
  invalidTitle: "This link is not valid",
  invalidText:
    "The link may be incomplete, or a newer link replaced it. Open the newest email from us, or fill in the signup form again.",
  unavailableTitle: "This form is not available",
  unavailableText: "Try again later.",
  previewWidget: "The bot check shows here",
  verifyNote: "We use Cloudflare Turnstile to make sure that you are a person.",
} as const;

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f8f7f4; --card: #ffffff; --fg: #1a1917; --muted: #6b675f; --border: #edebe6;
  --hairline: #f1efeb; --input: #e6e3dd; --primary: #1a1917; --primary-fg: #ffffff;
  --ring: #7b66c4; --notice: #e6efee; --notice-fg: #2e4b4a; --error: #fbe4e1; --error-fg: #8a2b1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141312; --card: #1a1917; --fg: #edebe6; --muted: #a39e94; --border: #2a2826;
    --hairline: #232220; --input: #3a3834; --primary: #edebe6; --primary-fg: #141312;
    --ring: #b3a3e6; --notice: #1f2e2d; --notice-fg: #b7d3d1; --error: #3a1f1b; --error-fg: #f2b8ae;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.55 "Geist", "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; align-items: center; padding: 40px 16px 24px;
}
body.embed { padding: 12px 12px 8px; }
main { width: 100%; max-width: 520px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 28px; }
h1 { margin: 0; font-size: 21px; line-height: 1.25; font-weight: 600; letter-spacing: -0.025em; overflow-wrap: anywhere; }
p { margin: 10px 0 0; }
.muted { color: var(--muted); }
.prewrap { white-space: pre-line; overflow-wrap: anywhere; }
.field { margin-top: 16px; }
.field > label, legend { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; padding: 0; }
fieldset { margin: 16px 0 0; padding: 0; border: 0; min-width: 0; }
input[type=email], input[type=text], input[type=number], input[type=date] {
  width: 100%; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--input);
  border-radius: 8px; padding: 8px 11px; min-height: 38px;
}
input[aria-invalid=true] { border-color: var(--error-fg); }
.choices { display: flex; flex-direction: column; gap: 6px; }
.choice { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 14px; }
.choice input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary); flex: none; }
.consent { margin-top: 16px; font-size: 13px; color: var(--muted); }
.turnstile { margin-top: 16px; min-height: 65px; }
.placeholder { display: flex; align-items: center; justify-content: center; height: 65px; border: 1px dashed var(--input); border-radius: 8px; color: var(--muted); font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; align-items: center; }
button, .button {
  font: inherit; font-weight: 500; font-size: 14px; line-height: 20px; border-radius: 8px;
  padding: 9px 16px; cursor: pointer; text-decoration: none; display: inline-block;
  border: 1px solid var(--primary); background: var(--primary); color: var(--primary-fg);
}
button[disabled] { opacity: 0.6; cursor: not-allowed; }
.secondary { background: transparent; color: var(--fg); border-color: var(--input); }
.busy { display: none; }
form:has(.submit:focus:not(:focus-visible)):has(input[type=email]:valid) .submit .idle { display: none; }
form:has(.submit:focus:not(:focus-visible)):has(input[type=email]:valid) .submit .busy { display: inline; }
button:focus-visible, .button:focus-visible, input:focus-visible, .errors:focus-visible, .errors a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.errors { margin: 16px 0 0; padding: 12px 14px; border-radius: 10px; background: var(--error); color: var(--error-fg); font-size: 13px; }
.errors h2 { margin: 0; font-size: 13px; font-weight: 600; }
.errors ul { margin: 6px 0 0; padding-left: 18px; }
.errors a { color: inherit; }
.inline-error { margin: 6px 0 0; font-size: 12px; color: var(--error-fg); }
.notice { margin: 16px 0 0; padding: 10px 14px; border-radius: 10px; background: var(--notice); color: var(--notice-fg); font-size: 13px; }
.note { margin-top: 12px; font-size: 12px; color: var(--muted); }
footer { margin-top: 14px; font-size: 12px; color: var(--muted); text-align: center; }
footer a { color: inherit; text-decoration: underline; text-decoration-color: var(--input); text-underline-offset: 3px; }
footer a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 2px; }
@media (max-width: 480px) {
  body { padding: 16px 12px 12px; }
  body.embed { padding: 4px 4px 8px; }
  .card { padding: 20px 16px; }
  h1 { font-size: 19px; }
}
`;

/** The style block of the page, for its nonce. */
export const FORM_PAGE_CSS = CSS;

/** Escapes text for HTML element content and attribute values. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The id of the input of a custom field. Keys are lowercase letters, digits, and underscores. */
export function fieldInputId(key: string): string {
  return `field-${key}`;
}

/** The form field name of a custom field. */
export function fieldInputName(key: string): string {
  return `f_${key}`;
}

// Height of the embed (the iframe snippet). Each part is the height in CSS pixels at a
// width of 360 px, with room for one line of wrap. The error summary and the Turnstile
// widget are always counted, so every state fits the same height.
const HEIGHT = {
  frame: 24 + 22,
  title: 56,
  email: 72,
  textField: 80,
  checkbox: 40,
  legend: 34,
  option: 28,
  consent: 64,
  turnstile: 81,
  button: 58,
  errors: 112,
  footer: 32,
};

/** The recommended iframe height in pixels for a form with these fields. */
export function recommendedFormHeight(fields: readonly Pick<FormPageField, "type" | "options">[]) {
  let height =
    HEIGHT.frame +
    HEIGHT.title +
    HEIGHT.email +
    HEIGHT.consent +
    HEIGHT.turnstile +
    HEIGHT.button +
    HEIGHT.errors +
    HEIGHT.footer;
  for (const field of fields) {
    if (field.type === "choice" || field.type === "multi") {
      height += HEIGHT.legend + 16 + field.options.length * HEIGHT.option;
    } else if (field.type === "boolean") {
      height += HEIGHT.checkbox;
    } else {
      height += HEIGHT.textField;
    }
  }
  return Math.ceil(height / 10) * 10;
}

/** The iframe snippet that a website owner pastes into a page. */
export function embedSnippet(hostedUrl: string, title: string, height: number): string {
  return `<iframe src="${esc(hostedUrl)}?embed=1" title="${esc(title)}" width="100%" height="${height}" style="border:0;max-width:560px;width:100%" loading="lazy"></iframe>`;
}

function errorFor(errors: readonly FormPageError[], target: string): FormPageError | undefined {
  return errors.find((error) => error.target === target);
}

function invalidAttrs(error: FormPageError | undefined, id: string): string {
  return error ? ` aria-invalid="true" aria-describedby="${esc(id)}-error"` : "";
}

function inlineError(error: FormPageError | undefined, id: string): string {
  return error ? `<p class="inline-error" id="${esc(id)}-error">${esc(error.message)}</p>` : "";
}

function selected(values: FormPageValues | undefined, key: string): readonly string[] {
  const value = values?.fields[key];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

function customField(
  field: FormPageField,
  values: FormPageValues | undefined,
  errors: readonly FormPageError[],
): string {
  const id = fieldInputId(field.key);
  const name = fieldInputName(field.key);
  const error = errorFor(errors, id);
  const current = selected(values, field.key);
  if (field.type === "choice" || field.type === "multi") {
    const type = field.type === "choice" ? "radio" : "checkbox";
    const options = field.options
      .map((option, index) => {
        const optionId = index === 0 ? id : `${id}-${option.id}`;
        const checked = current.includes(String(option.id)) ? " checked" : "";
        return `<label class="choice"><input type="${type}" id="${esc(optionId)}" name="${esc(name)}" value="${option.id}"${checked}${index === 0 ? invalidAttrs(error, id) : ""}><span>${esc(option.label)}</span></label>`;
      })
      .join("");
    return `<fieldset><legend>${esc(field.label)}</legend><div class="choices">${options}</div>${inlineError(error, id)}</fieldset>`;
  }
  if (field.type === "boolean") {
    const checked = current.includes("true") ? " checked" : "";
    return `<div class="field"><label class="choice"><input type="checkbox" id="${esc(id)}" name="${esc(name)}" value="true"${checked}><span>${esc(field.label)}</span></label></div>`;
  }
  const inputType = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
  const extra = field.type === "number" ? ' step="any" inputmode="decimal"' : "";
  return `<div class="field"><label for="${esc(id)}">${esc(field.label)}</label><input type="${inputType}" id="${esc(id)}" name="${esc(name)}" value="${esc(current[0] ?? "")}" maxlength="1000"${extra}${invalidAttrs(error, id)}>${inlineError(error, id)}</div>`;
}

function errorSummary(errors: readonly FormPageError[]): string {
  if (errors.length === 0) return "";
  const items = errors
    .map((error) =>
      error.target
        ? `<li><a href="#${esc(error.target)}">${esc(error.message)}</a></li>`
        : `<li>${esc(error.message)}</li>`,
    )
    .join("");
  // `autofocus` moves the focus to the summary without a script, so a screen reader
  // reads the problems first. tabindex -1 makes the region focusable.
  return `<div class="errors" id="errors" role="alert" tabindex="-1" autofocus aria-labelledby="errors-title"><h2 id="errors-title">${FORM_COPY.errorTitle}</h2><ul>${items}</ul></div>`;
}

function turnstileWidget(siteKey: string | null, action: string): string {
  if (siteKey === null) {
    return `<div class="turnstile"><div class="placeholder" aria-hidden="true">${FORM_COPY.previewWidget}</div></div>`;
  }
  return `<div class="turnstile"><div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-action="${esc(action)}" data-size="flexible" data-theme="auto" data-response-field-name="cf-turnstile-response"></div></div>`;
}

function formBody(view: Extract<FormPageView, { kind: "form" }>): string {
  const errors = view.errors ?? [];
  const emailError = errorFor(errors, "email");
  const preview = view.siteKey === null;
  const fields = view.form.fields.map((field) => customField(field, view.values, errors)).join("");
  const button = preview
    ? `<button type="button" disabled>${FORM_COPY.submit}</button>`
    : `<button type="submit" class="submit"><span class="idle">${FORM_COPY.submit}</span><span class="busy" aria-hidden="true">${FORM_COPY.submitting}</span></button>`;
  return [
    `<h1>${esc(view.form.name)}</h1>`,
    errorSummary(errors),
    `<form method="post" action="${esc(view.action)}" novalidate>`,
    `<div class="field"><label for="email">${FORM_COPY.emailLabel}</label><input type="email" id="email" name="email" required autocomplete="email" maxlength="254" value="${esc(view.values?.email ?? "")}"${invalidAttrs(emailError, "email")}>${inlineError(emailError, "email")}</div>`,
    fields,
    `<p class="consent prewrap" id="consent">${esc(view.form.consentText)}</p>`,
    turnstileWidget(view.siteKey, TURNSTILE_ACTIONS.signup),
    `<div class="actions">${button}</div>`,
    `<p class="note">${FORM_COPY.confirmNote}</p>`,
    "</form>",
  ].join("");
}

function body(view: FormPageView): string {
  switch (view.kind) {
    case "form":
      return formBody(view);
    case "inbox":
      return [
        `<h1>${FORM_COPY.inboxTitle}</h1>`,
        `<p class="muted" role="status">${FORM_COPY.inboxText}</p>`,
        view.backHref
          ? `<div class="actions"><a class="button secondary" href="${esc(view.backHref)}">${FORM_COPY.inboxBack}</a></div>`
          : "",
      ].join("");
    case "confirm":
      return [
        `<h1>${FORM_COPY.confirmTitle}</h1>`,
        `<p class="muted">${esc(view.form.name)}</p>`,
        `<p>${FORM_COPY.confirmText}</p>`,
        `<form method="post" action="${esc(view.action)}"><div class="actions"><button type="submit">${FORM_COPY.confirmButton}</button></div></form>`,
      ].join("");
    case "confirmed":
      return [
        `<h1>${FORM_COPY.confirmedTitle}</h1>`,
        `<p class="muted prewrap" role="status">${esc(view.form.successMessage)}</p>`,
      ].join("");
    case "expired": {
      const parts = [
        `<h1>${FORM_COPY.expiredTitle}</h1>`,
        `<p class="muted">${esc(view.form.name)}</p>`,
      ];
      if (view.error) {
        parts.push(
          `<div class="errors" role="alert" tabindex="-1" autofocus><p>${esc(view.error)}</p></div>`,
        );
      }
      if (!view.canResend) {
        parts.push(`<p>${FORM_COPY.expiredNoMore}</p>`);
      } else {
        parts.push(
          `<p>${FORM_COPY.expiredText}</p>`,
          `<form method="post" action="${esc(view.action)}">`,
          turnstileWidget(view.siteKey, TURNSTILE_ACTIONS.resend),
          `<div class="actions"><button type="submit">${FORM_COPY.resendButton}</button></div>`,
          "</form>",
        );
      }
      return parts.join("");
    }
    case "invalid":
      return `<h1>${FORM_COPY.invalidTitle}</h1><p class="muted">${FORM_COPY.invalidText}</p>`;
    default:
      return `<h1>${FORM_COPY.unavailableTitle}</h1><p class="muted">${esc(view.detail ?? FORM_COPY.unavailableText)}</p>`;
  }
}

function titleOf(view: FormPageView): string {
  switch (view.kind) {
    case "form":
      return view.form.name;
    case "inbox":
      return FORM_COPY.inboxTitle;
    case "confirm":
      return FORM_COPY.confirmTitle;
    case "confirmed":
      return FORM_COPY.confirmedTitle;
    case "expired":
      return FORM_COPY.expiredTitle;
    case "invalid":
      return FORM_COPY.invalidTitle;
    default:
      return FORM_COPY.unavailableTitle;
  }
}

/** True when the view loads the Turnstile script. */
export function usesTurnstile(view: FormPageView): boolean {
  return (
    (view.kind === "form" && view.siteKey !== null) ||
    (view.kind === "expired" && view.canResend && view.siteKey !== null)
  );
}

/** The page as a complete HTML document. */
export function renderFormPage(view: FormPageView, layout: FormPageLayout): string {
  const script = usesTurnstile(view)
    ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>`
    : "";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${esc(titleOf(view))}</title>`,
    `<style nonce="${esc(layout.nonce)}">${CSS}</style>`,
    script,
    `</head><body${layout.embed ? ' class="embed"' : ""}><main><div class="card">`,
    body(view),
    "</div>",
    `<footer>Sent with Envelopen ${esc(layout.version)} · <a href="${esc(layout.sourceUrl)}" rel="noreferrer" target="_blank">Source code</a></footer>`,
    "</main></body></html>",
  ].join("");
}
