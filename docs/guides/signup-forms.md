# Signup forms

This guide explains how to create a signup form, how to put it on your website or post your own form to it, and how double opt-in works. A form adds a subscriber to your lists only after the subscriber confirms the address.

## Before you start

- Sign in as the owner. Only the owner session can create and change forms. An API key with `contacts:read` can read forms, for example to get the hosted link.
- Connect an email provider. The confirmation email goes through the connection of the workspace as system email, so a transactional-only provider also works. See the [provider guides](README.md#email-providers).
- Verify a sending domain. The confirmation email needs a From address on a sending domain of the workspace. See [Set up a sending domain](sending-domain.md).
- Create at least one list. A form must have a list before you can turn it on.
- Optional: create the custom fields that the form asks. See [Custom fields on a form](#custom-fields-on-a-form).
- Set up Cloudflare Turnstile. Without the Turnstile secrets, every form shows "This form is not available" and refuses submissions. See [Set up Turnstile](#set-up-turnstile).

## Steps

### Set up Turnstile

Turnstile is the bot check of Cloudflare. The form page shows the widget, and the Worker checks each token with Cloudflare before it accepts a submission or a resend.

1. In the Cloudflare dashboard, open **Turnstile**, and select **Add widget**.
2. Type a name for the widget, for example `Envelopen forms`.
3. Under the hostnames, add the hostname of your deployment, for example `envelopen.example.workers.dev`. If people also open the Worker on a custom domain, add that hostname too.
4. Select the widget mode **Managed**.
5. Create the widget. Copy the site key and the secret key.
6. Set the two keys as Worker secrets. Use one of these methods:

   - From the root of your deployment repository, run:

     ```sh
     npx wrangler secret put TURNSTILE_SITE_KEY
     npx wrangler secret put TURNSTILE_SECRET
     ```

   - In the Cloudflare dashboard, open the Worker, then **Settings** > **Variables and Secrets**. Select **Add variable** for each key, and set **Type** to **Secret**.

   Do not use the type **Text**, also for the site key. Each deploy replaces the text variables with the `vars` of `wrangler.jsonc`, so a text key disappears at the next update. Secrets stay. Ignore the dashboard notice that tells you to add a text variable to `wrangler.jsonc`.

7. Open **Forms** in Envelopen. Check that the notice "Forms cannot take signups yet" is gone.

For the hosted page and the iframe, you do not add the websites that embed the form to the widget. The widget runs on the hosted page of the Worker, also inside an iframe. The Worker accepts a token only when its hostname is the hostname of the form page, and its action is the action of the widget (`signup` or `resend`).

For [your own form](#use-your-own-form), the widget runs on your website. Add the hostname of each of those websites to the widget, for example `www.example.com`. A widget on the Free plan holds at most 10 hostnames, for all workspaces of the deployment together. A hostname also covers its subdomains.

For local development, use the test keys of Cloudflare in `.dev.vars`. They always pass. See `.dev.vars.example`.

### Create a form

1. Open **Forms**, and select **New form**.
2. In **Name**, type the title of the form page. The limit is 100 characters.
3. Under **Lists**, select the lists that a confirmed subscriber joins. The limit is 20 lists.
4. Under **Fields to ask**, select the custom fields of the form. The limit is 10 fields. The form always asks for the email address.
5. Under **Required answers**, select the fields that a subscriber must answer.
6. In **Consent text**, type the text that the form shows above the button. The limit is 2,000 characters.
7. In **Success message**, type the text that the page shows after the subscriber confirms. The limit is 500 characters.
8. Optional: in **Websites that can embed the form**, type one origin on each line. See [Embed the form on a website](#embed-the-form-on-a-website).
9. Optional: type a **From name** and a **From address** for the confirmation email. If **From address** is empty, Envelopen sends from `noreply@` on the first verified sending domain. If **From name** is empty, Envelopen uses the name of the workspace.
10. Select **Form is on**.
11. Select **Create form**.

The preview on the right shows the form at 360 px and 640 px wide. Use **Page state** to see the other pages, for example **Check your inbox** and **Link expired**.

Form text shows as plain text. HTML in the name, the consent text, or the success message is not run.

### Consent text and versions

Each form starts at consent version 1. When you change the consent text and save the form, the version goes up by one. A signup keeps the version of the text that the subscriber saw when they submitted the form.

### Share the hosted page

After you create the form, the section **Share and embed** shows the **Hosted page**. Copy the link, and share it in an email, a social post, or a QR code. The link has the form `https://<your-worker>/f/<id>`. The id is random.

The hosted page has a fluid width and a mobile layout. It needs JavaScript only for the Turnstile widget.

### Embed the form on a website

1. In **Websites that can embed the form**, type the origin of each website, one on each line. Use the form `https://www.example.com`.
2. Select **Save form**.
3. Under **Share and embed**, copy the **Iframe snippet**.
4. Paste the snippet into the HTML of your website.

The rules for an origin:

- Use `https`. Plain `http` works only for `localhost`, for local tests.
- Use only the scheme, the host, and an optional port. Do not add a path, a query, or a fragment.
- Do not use a wildcard. Add each subdomain on its own line, for example `https://example.com` and `https://www.example.com`.
- The limit is 10 origins.

Envelopen puts these origins in the `frame-ancestors` policy of the form page. A browser refuses to show the form in an iframe on any other website.

The snippet sets a recommended height in pixels. The editor shows the number in the hint of **Iframe snippet**. This height fits every state of the form, including the error summary. The height grows with the number of fields and options. If you add fields or options, copy the snippet again. The snippet sets a width of 100% and a maximum width of 560 px.

### Use your own form

Your website can render its own form and post it to Envelopen. Envelopen keeps the same rules as for the hosted page: Turnstile, the rate limits, double opt-in, and the consent record.

1. In **Websites that can embed the form**, type the origin of your website, for example `https://www.example.com`. The rules for an origin are the same as for the iframe.
2. Select **Save form**.
3. Add the hostname of your website to your Turnstile widget. See [Set up Turnstile](#set-up-turnstile).
4. Under **Share and embed** > **Your own form**, copy the **Example**.
5. Paste the example into your website, and change the markup and the styles as necessary.

The example loads the form, shows the fields and the consent text, runs the Turnstile widget, and posts the answers. It shows the owner's texts as plain text.

Your website must show the consent text from the metadata, and send the consent version of that text. Envelopen cannot see your page, so the consent record names your website as the place where the subscriber saw the text. See [The consent record](#the-consent-record).

Remove `http://localhost` origins before you go live. An origin in the list can post the form.

If your website has a Content Security Policy, allow `https://challenges.cloudflare.com` in `script-src` and `frame-src`, and the origin of your deployment in `connect-src`.

#### Load the form

Send `GET https://<your-worker>/f/<id>.json`. The **Metadata URL** in the editor is this URL.

```json
{
  "ok": true,
  "name": "Course news",
  "consentText": "I agree to get the course news.",
  "consentVersion": 3,
  "fields": [
    {
      "key": "topics",
      "label": "Topics",
      "type": "multi",
      "options": [{ "id": 12, "label": "Design" }],
      "required": false
    }
  ],
  "turnstile": { "siteKey": "0x4AAAA...", "action": "signup-headless" },
  "submitUrl": "https://<your-worker>/f/<id>"
}
```

The field `type` is `text`, `number`, `date`, `boolean`, `choice`, or `multi`. Do not keep the metadata in a cache. If the consent text changes, a submission with the old version fails.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true, ... }` | The form is on. |
| 404 | `{ "ok": false, "reason": "unavailable" }` | The form does not exist or is off. |
| 503 | `{ "ok": false, "reason": "not_set_up" }` | Turnstile is not set up. |

#### Submit the form

Send `POST https://<your-worker>/f/<id>` from the browser, with the header `Content-Type: application/json`:

```json
{
  "email": "reader@example.org",
  "fields": { "topics": ["12"], "company": "Example Ltd" },
  "consentVersion": 3,
  "turnstileToken": "<token from the widget>"
}
```

- Give each field value as a string, or as a list of strings. For a choice field, send the option ids. For a **Yes or no** field, send `"true"` when the box is selected.
- Render the Turnstile widget with the site key and the action from the metadata. A token works one time only. Reset the widget after each submission.
- Post from the browser of the subscriber, not from your server. The rate limit counts each IP address, and the Turnstile token must come from a widget on your website.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true }` | Show "Check your inbox". The answer is the same for every valid submission, so it does not show if the address is already on your lists. |
| 400 | `{ "ok": false, "errors": [{ "target": "email", "message": "..." }] }` | A value or the Turnstile check failed. `target` is `email`, a field key, or `null` for the whole form. |
| 403 | `{ "ok": false, "reason": "origin" }` | The request has no `Origin`, or the origin is not in **Websites that can embed the form**. |
| 404 | `{ "ok": false, "reason": "unavailable" }` | The form does not exist or is off. |
| 409 | `{ "ok": false, "reason": "consent_changed" }` | The consent text changed. Load the metadata again, show the new text, and let the subscriber submit again. |
| 503 | `{ "ok": false, "reason": "not_set_up" }` or `"unavailable"` | Turnstile is not set up, or the Worker could not do the request. Try again later. |

Envelopen sends CORS headers only to an origin in the list. It does not allow credentials. The confirmation link in the email opens the Worker, not your website.

The `Origin` check stops other websites in a browser. It does not stop a script, because a script can send any `Origin`. The Turnstile check stops scripts: the Worker accepts a token only when its hostname is the host of the `Origin`, and its action is `signup-headless`.

### Custom fields on a form

A form can ask any custom field of the workspace. Create the fields in **Contacts** > **Fields**:

1. Select **New field**.
2. Type a **Label** and a **Merge tag**. The merge tag uses lowercase letters, digits, and underscores.
3. Select the **Type**: text, number, date, **Yes or no**, **Single choice**, or **Multiple choice**.
4. For a choice field, type the **Options**, one on each line. A label cannot contain a comma. The limit is 100 options.
5. Select **Create field**.

On the form, a single-choice field shows as radio buttons, and a multiple-choice field shows as check boxes. The form accepts only the options of the field. A forged option id fails the submission.

You can rename an option. Contacts keep the option, and merge tags and forms show the new label. You cannot delete an option that contacts hold. Merge it into another option first, with **Move its contacts to** and **Merge and delete**.

A merge tag of a choice field prints the labels, separated by ", ".

### The preference page

Each email links to the preference page. For each field, set **On the preference page** in **Contacts** > **Fields**:

| Setting | What the subscriber sees |
|---|---|
| **Hidden** | Nothing. |
| **Read only** | The answer as text. |
| **Subscriber can change it** | An input. The subscriber can change the answer and save it. |

At the D1 daily limit, the page saves the list choices but not the answers. It shows "Your list choices are saved. Your answers were not saved. Try again later."

### What the subscriber sees

1. The subscriber fills in the form, waits for the Turnstile check, and selects **Subscribe**.
2. The page shows **Check your inbox**. The page is the same for every valid submission, so it does not show if the address is already on your lists.
3. The subscriber gets the email "Confirm your subscription to `<form name>`". The link is valid for 72 hours.
4. The link opens a page with a **Confirm** button. Opening the link does not confirm. This keeps mail scanners from confirming an address.
5. The subscriber selects **Confirm**. The page shows **You are subscribed** and your success message.

If the link expired, the page shows **This link has expired** and a **Send a new link** button. A new link needs a Turnstile check, and it stops the old link. A signup can get at most 3 new links. After that, the subscriber must fill in the form again.

If a newer link replaced the link, the form is off, or the address was suppressed after the submission, the page shows **This link is not valid**.

### What happens on confirm

When the subscriber selects **Confirm**, Envelopen makes these changes in one database batch:

- It creates the contact, or it uses the existing contact. An earlier "unsubscribe from all" is lifted, because the confirmation is the newest choice of the subscriber.
- It sets the consent basis to **Explicit opt-in** with the source `form`.
- It subscribes the contact to each list of the form that still exists.
- It saves the answers of the fields that the form still asks.
- It starts the welcome series of each list, if the series is on. See [Welcome series](welcome-series.md).

### The consent record

Each confirmation adds a consent event to the contact. The contact page shows it in the consent history, with the note "Double opt-in through the signup form" and the form name. The event also stores this evidence:

- The form.
- The consent text version that the subscriber saw.
- The source of the signup: the hosted page, the iframe, or your own form. For your own form, it also stores the origin of your website.
- A keyed hash of the IP address of the submission. Envelopen does not store the IP address.
- The user agent of the browser, up to 300 characters.

The evidence is in the backups. An erase of the contact removes it.

### When no email goes out

Envelopen shows **Check your inbox** for every valid submission. In these cases, it sends no email:

| Case | Rule |
|---|---|
| Suppressed or erased address | A keyed hash of the address is on the suppression list. |
| Already subscribed | The contact is subscribed to every list of the form. |
| Unsubscribe waiting | An unsubscribe of the contact waits in the ledger at the D1 daily limit. |
| D1 daily limit | D1 refuses writes. Envelopen writes and sends nothing. |
| Address limit | 1 confirmation email for each address in 1 hour. Submissions and new links count together. |
| Form limit | 200 confirmation emails for each form in 1 hour. |
| Workspace limit | 1,000 confirmation emails for each workspace in 1 day. |
| IP limit | 20 submissions from one IP address in 10 minutes. |

The response time is the same in each case, because the Worker does the signup work after it sends the page.

The rate limits count only confirmation emails that go out. A failed send does not count, for example when the workspace has no verified sending domain. A submission that a limit stops does not count either. A confirmation email that waits for the daily cap counts, because it goes out later.

The Worker logs show the reason for each signup that gets no email, except at the IP limit. To read them, run `npx wrangler tail`. A log line has the form id, the source (`hosted`, `embed`, or `headless`), and the reason. For a rate limit, it also names the limit: `address`, `form`, or `workspace`. The line has no address, no address hash, and no IP address. For example:

```
Form 3: no confirmation email (rate_limited: address, headless)
```

Confirmation emails do not use the reserved D1 budget of welcome emails. They stop only at the D1 daily limit.

### Pending signups

A signup that is not confirmed is pending. A pending signup is not a contact and not a list member, so no campaign and no welcome series reaches it.

The pending signup stores the address, the answers, the consent text version, the IP hash, and the user agent. The answers are cleared on confirm. The daily cron deletes a signup 7 days after its creation, when its link has expired or the subscriber confirmed. An erase of the address deletes its pending signups at once. When you delete a form, Envelopen deletes its pending signups. Subscribers who confirmed stay on your lists.

### Turn a form off

1. Open the form.
2. Clear **Form is on**.
3. Select **Save form**.

The hosted page and the embeds show "This form is not available". Confirmation links of the form stop working.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The form shows "This form is not set up yet. Try again later." | `TURNSTILE_SITE_KEY` or `TURNSTILE_SECRET` is missing. | Set both secrets. See [Set up Turnstile](#set-up-turnstile). |
| The form shows "We could not make sure that you are a person." on each submission. | The hostname of the form page is not in the widget, or the secret is not the secret of the same widget. | Add the hostname to the widget. Set the secret of that widget again. |
| The iframe is empty, or the browser says that it refused to connect. | The website is not in **Websites that can embed the form**. | Add the exact origin of the website, for example with or without `www`, and save the form. |
| "The origin ... is not valid." on save. | The origin has a wildcard, a path, a query, or `http`. | Type only `https://` and the host. |
| "Select at least one list before you turn on the form." | The form has no list. | Select a list under **Lists**. |
| "The From address must be on a sending domain of this workspace." | The domain of **From address** is not a sending domain. | Add and verify the domain, or clear **From address**. |
| The subscriber gets no confirmation email. | One of the cases in [When no email goes out](#when-no-email-goes-out), no verified sending domain, or a provider refusal. | Check the Worker logs with `npx wrangler tail`. |
| No confirmation email after a test. | One of the cases in [When no email goes out](#when-no-email-goes-out). Often it is the address limit after an earlier test with the same address. | Read the reason in the Worker logs with `npx wrangler tail`. Or test with a new address. |
| Your own form gets 403 on each submission. | The origin of the page is not in **Websites that can embed the form**. | Add the exact origin of the page, and save the form. |
| Your own form shows "We could not make sure that you are a person." on each submission. | The hostname of your website is not in the Turnstile widget, or the widget does not use the action `signup-headless`. | Add the hostname to the widget. Render the widget with the action from the metadata. |
| Your own form gets 409. | The consent text changed after the page loaded the metadata. | Load the metadata again. The example does this. |
| The iframe cuts off the form. | The height in the snippet is from an older version of the form. | Copy the **Iframe snippet** again after you change fields or options. |
| "This link has expired" and no **Send a new link** button. | The signup got 3 new links, or Turnstile is not set up. | Fill in the form again. |
| "N contacts hold the option ..." when you delete an option. | Contacts hold the option. | Select an option in **Move its contacts to**, then **Merge and delete**. |

## Related guides

- [Welcome series](welcome-series.md)
- [Import contacts](import-contacts.md)
- [Set up a sending domain](sending-domain.md)
- [Cloudflare Workers platform](cloudflare-platform.md)
- [Back up and restore](backup-and-restore.md)

## Sources

- [Cloudflare Turnstile: get started](https://developers.cloudflare.com/turnstile/get-started/)
- [Cloudflare Turnstile: server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare Turnstile: testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
- [Cloudflare Turnstile: hostname management](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
- [Cloudflare Turnstile: plans](https://developers.cloudflare.com/turnstile/plans/)

Last checked: 2026-11-10
