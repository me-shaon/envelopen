/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Subscription } from "@envelopen/core";
import type { Child } from "hono/jsx";

// The public subscription pages (R24, KTD30): server-rendered Hono JSX with plain HTML
// forms, so they work without JavaScript and send no script at all. They follow the
// Calm look of the admin app (plan U5): a warm off-white page, a white card with a
// hairline border, black primary buttons, and the Geist type scale with system fallbacks.
//
// States: the preference page, the "unsubscribe from all" confirmation, unsubscribed
// (just now, or already) with a resubscribe form, an invalid or forged link (one
// generic message), and an error when the change could not be saved.
//
// Every response sends a strict Content-Security-Policy: no scripts, the one inline
// style block by nonce, and forms that post only to this origin (KTD27).

export type PageNotice = "saved" | "resubscribed" | null;

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
    }
  | { kind: "confirm_all"; sub: Subscription; csrf: string; action: string; backHref: string }
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
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141312; --card: #1a1917; --fg: #edebe6; --muted: #a39e94; --border: #2a2826;
    --hairline: #232220; --input: #3a3834; --primary: #edebe6; --primary-fg: #141312;
    --ring: #b3a3e6; --notice: #1f2e2d; --notice-fg: #b7d3d1; --tone: #3a2a20; --tone-fg: #f0c3a8;
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
@media (max-width: 480px) { body { padding-top: 24px; } .card { padding: 24px 20px; } }
`;

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(ms),
  );
}

function Layout({ title, nonce, children }: { title: string; nonce: string; children: Child }) {
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
          <footer>Sent with Envelopen</footer>
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

function Preferences({ view }: { view: Extract<PageView, { kind: "preferences" }> }) {
  const { sub, csrf, action, confirmHref, notice } = view;
  return (
    <>
      <p class="eyebrow">{sub.workspaceName}</p>
      <h1>Email preferences</h1>
      <p class="muted">
        Choose the emails that <span class="email">{sub.email}</span> gets from {sub.workspaceName}.
      </p>
      {notice === "saved" ? (
        <p class="notice" role="status">
          Your choices are saved.
        </p>
      ) : null}
      {notice === "resubscribed" ? (
        <p class="notice" role="status">
          You are subscribed again.
        </p>
      ) : null}
      {sub.lists.length > 0 ? (
        <form method="post" action={action}>
          <Csrf value={csrf} />
          <input type="hidden" name="action" value="save" />
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
                      checked={list.status === "subscribed"}
                    />
                    <span>{list.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div class="actions">
            <button type="submit">Save preferences</button>
          </div>
        </form>
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

/** The page as a complete HTML document, and the nonce of its style block. */
export async function renderPage(view: PageView): Promise<{ html: string; nonce: string }> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const body = (
    <Layout title={titleOf(view)} nonce={nonce}>
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

export async function pageResponse(view: PageView, status = 200): Promise<Response> {
  const { html, nonce } = await renderPage(view);
  return new Response(html, { status, headers: pageHeaders(nonce) });
}
