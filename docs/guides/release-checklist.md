# Release checklist

The automated tests run in the local Workers runtime with mocked providers. Some facts need a real deployment, a real provider, or a real inbox. Do these checks before a release, and record each result with the date.

Use a separate Cloudflare account on the Workers Free plan for the deploy checks, if you can. Free has the tightest limits. Never send to real people during these checks. Send only to your own addresses.

## 1. Deploy button on a Free account

Expected result: the button provisions every binding, and the first-run screen shows "9 of 9 pass".

1. Open the Deploy to Cloudflare link in the [README](../../README.md) with a Free account.
2. Enter `SETUP_TOKEN`, `SIGNING_KEY`, and `ENCRYPTION_KEY`.
3. Wait for the build and the deploy to finish.
4. In the dashboard, check that these exist: the D1 database, the KV namespace, the R2 bucket, `send-queue`, `send-queue-dlq`, the import Workflow, the campaign Workflow, and the four Durable Object classes.
5. Open `/setup` on the Worker, and type the setup token.
6. Check that the deployment check shows "9 of 9 pass".

Record if the dead-letter queue exists on Free. The plan lists this as an open question.

## 2. PBKDF2 cost and the 100,000 cap

Expected result: the largest iteration count with p99 CPU time below about 8 ms, and a cap of 100,000.

1. From the repository root, deploy the benchmark Worker: `npx wrangler deploy --config apps/worker/scripts/pbkdf2-benchmark/wrangler.jsonc`.
2. Send about 20 requests for each count:

   ```sh
   for n in 10000 25000 50000 75000 100000; do
     for i in $(seq 20); do curl -s "https://<worker-url>/?op=verify&iterations=$n" >/dev/null; done
   done
   ```

3. Read the CPU time of each request in **Workers & Pages** > **envelopen-pbkdf2-benchmark** > **Logs**. You can also use `npx wrangler tail --format json` and read `cpuTime`.
4. Select the largest count whose p99 CPU time stays below about 8 ms.
5. Set `PBKDF2_ITERATIONS` in `wrangler.jsonc` to that count. Below 100,000, the first-run screen enrolls a passkey instead of a password.
6. Probe the cap: `curl "https://<worker-url>/cap"`. Expect 100,000 to work and 100,001 to fail.
7. Delete the Worker: `npx wrangler delete --name envelopen-pbkdf2-benchmark`.

## 3. Personalization benchmark

Expected result: a batch of 50 recipients has p99 CPU time below about 5 ms.

1. Deploy the benchmark Worker: `npx wrangler deploy --config apps/worker/scripts/personalize-benchmark/wrangler.jsonc`.
2. Send about 20 requests for each batch size:

   ```sh
   for n in 10 25 50 100; do
     for i in $(seq 20); do curl -s "https://<worker-url>/?recipients=$n" >/dev/null; done
   done
   ```

3. Repeat step 2 with `&tracking=off` added to the URL.
4. Read `cpuTime` in the Logs, or with `npx wrangler tail --config apps/worker/scripts/personalize-benchmark/wrangler.jsonc --format json`.
5. If the batch of 50 is above 5 ms, lower the default batch size of the adapters in `packages/providers`.
6. Delete the Worker: `npx wrangler delete --name envelopen-personalize-benchmark`.

## 4. CPU per send batch on Free

Expected result: no "Exceeded CPU time limit" error in the send consumer, for each campaign provider.

1. On the Free deployment, import about 200 of your own test addresses. Use plus addresses, for example `you+1@gmail.com`.
2. Send a campaign to them through each campaign provider in turn (Amazon SES, Resend, Postmark).
3. Run `npx wrangler tail --format json` during the send.
4. Read `cpuTime` of each queue invocation, and look for errors.
5. Record the p99 CPU time per provider. If a provider is near 10 ms, lower its batch size.
6. Record if D1 calls count toward the 50 or the 1,000 subrequest limit. The plan lists this as an open question.

## 5. Unsubscribe headers in Gmail

Expected result: both headers are present, and SPF, DKIM, and DMARC pass, for each campaign provider.

Do this for Amazon SES, Resend, and Postmark:

1. Connect the provider, and verify the sending domain.
2. Send a campaign to a list that holds only your Gmail address.
3. In Gmail on the web, open the email, open the menu next to **Reply**, and select **Show original**.
4. Check that `List-Unsubscribe` holds an `https` URL with `/u/` and a token.
5. Check that `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click`.
6. Check that SPF, DKIM, and DMARC show **PASS**.

For Postmark, do the check before and after Postmark support turns on custom unsubscribe handling. See the [Postmark guide](provider-postmark.md).

## 6. One-click unsubscribe from Gmail and Yahoo

Expected result: the contact shows as unsubscribed in Envelopen, with the source "One-click unsubscribe" and the campaign.

1. Send a campaign to your Gmail address and to your Yahoo address.
2. In Gmail, select **Unsubscribe** next to the sender name, and confirm.
3. In Yahoo Mail, select **Unsubscribe** at the top of the email, and confirm.
4. In Envelopen, open each contact.
5. Check the banner "Unsubscribed from every list" with the source and the campaign number.
6. Check the stats of the campaign: **Unsubscribed** counts both contacts.

Gmail can take some minutes to send the POST request.

## 7. Real Queue redelivery

Expected result: a batch that fails with an unknown result is sent again after the lease ends, and no recipient gets two emails from an idempotent provider.

1. Connect Resend (idempotent).
2. Start a campaign to about 100 of your own test addresses.
3. During the send, make one consumer invocation fail. For example, deploy a build that throws after the provider call for one batch.
4. Deploy the normal build again.
5. Wait for the sweep (every minute) and the lease time.
6. Check that the batch is retried with the same idempotency key, and that each address got one email.
7. Check that `send-queue-dlq` holds no message, or only the message of the failed invocation.

## 8. Apple Mail Privacy Protection

Expected result: an open from Apple Mail with protection on is a machine open, not a human open.

1. On an iPhone or a Mac, turn on **Protect Mail Activity** in Mail settings.
2. Send a campaign to an address that this Mail app reads.
3. Open the email in Apple Mail.
4. Run `npx wrangler tail --format json`, and find the request to `/t/o/`.
5. Record `cf.asn` and the `User-Agent` of the request. Envelopen expects ASN 714 and a bare user agent (`apps/worker/src/tracking/classify.ts`).
6. Check the campaign stats: the open shows in machine opens, not in **Opened**.
7. If the values differ, update the classifier with the recorded values.

## 9. A real MCP client against a deployed Worker

Expected result: the agent completes the first-campaign flow through MCP only.

1. Create an API key with the **Agent sender** preset.
2. Add the server to a real MCP client. See [Connect an MCP client](mcp.md).
3. Ask the agent to call `get_workspace_context`.
4. Ask the agent to upsert two of your own addresses, to create a Markdown template, and to create a draft.
5. Ask the agent to send a test email.
6. Ask the agent to prepare the send and to show the estimate.
7. Ask the agent to confirm the send.
8. Check that the campaign reaches **Sent**.
9. Open the audit log, filter by the surface **MCP**, and check that each write shows the API key.

## 10. First campaign from the README only

Expected result: a new user sends a test campaign with only the README and the guides.

1. Give the README to a person who has not used Envelopen.
2. Ask the person to deploy, connect a provider with its API key, verify a domain, import contacts, and send a test campaign.
3. Record each step where the person needed help, and fix the guide.

## 11. One-click unsubscribe at the D1 daily limit (v0.2)

Expected result: the unsubscribe succeeds while D1 refuses writes, and the contact shows as unsubscribed after the reset.

1. On the Free deployment, send a campaign to two of your own addresses.
2. Bring D1 to its daily write limit. For example, import test addresses until the dashboard shows the limit.
3. Run `npx wrangler tail --format json`.
4. In Gmail, select **Unsubscribe** next to the sender name, and confirm.
5. Check in the tail that the POST to `/u/` returns 200.
6. On a page with a preference link, save the preferences. Check that the page shows success.
7. After 00:00 UTC, open the contact. Check the banner "Unsubscribed from every list" with the source "One-click unsubscribe".

## 12. Backup round trip to S3 (v0.2)

Expected result: the backup reaches R2 and the S3 store, and retention removes old copies in both.

1. Create a bucket in AWS S3 or Backblaze B2, and a key with only `PutObject` and `DeleteObject` on `backups/*`.
2. In **Settings** > **Backups**, set a passphrase, and add the destination in **Copy to S3**.
3. Select **Back up now**, and wait for **Succeeded**.
4. Check that `backups/<backup-id>/manifest.json` and the chunks exist in R2 and in the S3 bucket.
5. Change the secret access key to a wrong value, and back up again. Check that the run shows as partial, and that the banner shows on every page.
6. Set the right key again, and back up again. Check that the banner goes away.
7. Set **Keep backups for (days)** to 1. On the next day, check that the cron removed the old backups from R2 and S3, and kept the newest one.
8. Record the time and the rows read of the daily run at 02:23 UTC.

## 13. Restore on a fresh deployment (v0.2)

Expected result: the new deployment holds the same data, old unsubscribe links work, and sends wait for the age confirmation.

1. On the source deployment, select **Download** for a backup. Check that the audit log shows the download.
2. Deploy a second Envelopen with new secrets, on another hostname if you can.
3. Open `/setup`, type the setup token, and select **Restore a backup**.
4. Type a wrong passphrase once. Check that the restore stops before any write.
5. Upload the `.envbak` file, type the right passphrase, and select **Start the restore**.
6. Close the page during the restore, then open `/setup` again. Check that the progress shows.
7. When the restore is complete, sign in. Compare the counts of contacts, lists, templates, campaigns, and stats with the source.
8. Open an unsubscribe link from an email of the source deployment, with the hostname changed to the new deployment. Check that it works.
9. Check that a campaign send waits until you select **I checked. Allow sends**.
10. Repeat steps 2 to 5 with the R2 source: copy a backup folder into the R2 bucket of a fresh deployment.

## 14. Passphrase derivation time on Free (v0.2)

Expected result: the backup key is ready within about 30 seconds, and no Workflow step exceeds the CPU limit.

1. On the Free deployment, run `npx wrangler tail --format json`.
2. In **Settings** > **Backups**, set a passphrase.
3. Measure the time from **Set the passphrase** until the card shows **Set on**.
4. Read `cpuTime` of each step of the key derivation Workflow.
5. Do the same for the passphrase check at the start of a restore (check 13).
6. Record the times. If a step is near 10 ms of CPU, lower `PBKDF2_SEGMENT_ITERATIONS` in `packages/core/src/backup/crypto.ts`.

## 15. Turnstile on a real hostname and in an iframe (v0.3)

Expected result: a signup passes Turnstile on the hosted page and in an iframe on a real website, and an iframe on another website is blocked.

1. Create a Turnstile widget with the hostname of the deployment. Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`. See [Signup forms](signup-forms.md#set-up-turnstile).
2. Create a form with one list, one single-choice field, and one multiple-choice field.
3. Open the hosted page. Submit one of your own addresses, and check that the page shows **Check your inbox**.
4. Add the origin of a website that you control to **Websites that can embed the form**, and save the form.
5. Paste the **Iframe snippet** into a page of that website. Publish the page over https.
6. Submit another of your own addresses in the iframe. Check that the widget passes and that the page shows **Check your inbox**.
7. Check that the recommended height shows every state without a scroll bar. Look at the error summary and **Check your inbox**.
8. Paste the snippet into a page on a website that is not in the list. Check that the browser blocks the iframe.
9. In the browser console of each page, check that there is no Content-Security-Policy violation.
10. Run `npx wrangler tail --format json`. Check that no siteverify call fails with `hostname-mismatch` or `action-mismatch`.

## 16. Confirmation email through a real provider (v0.3)

Expected result: the confirmation email arrives in an inbox that you own, and the confirm adds the contact with the consent record.

1. Connect a real provider, and verify a sending domain.
2. Submit the form with an address that you own.
3. Check that the email "Confirm your subscription to `<form name>`" arrives. Check the From address, and check that SPF, DKIM, and DMARC pass.
4. Open the link. Check that the page shows **Confirm** and that the contact does not exist yet.
5. Select **Confirm**. Check that the page shows the success message.
6. Open the contact. Check the list, the answers, the basis **Explicit opt-in**, and the consent history entry of the form.
7. Submit the same address again within one hour. Check that the page shows **Check your inbox** and that no second email arrives.
8. Record the provider and the time from the submission to the email.

## 17. Welcome step through a real provider (v0.3)

Expected result: each step arrives once, after its wait, with working unsubscribe headers.

1. Create a series for the list of the form with two emails. Set a wait of 1 minute for email 1 and 5 minutes for email 2.
2. Turn the series on.
3. Confirm a signup with an address that you own.
4. Check that email 1 arrives after about 1 minute and email 2 after about 5 more minutes.
5. In Gmail, check `List-Unsubscribe` and `List-Unsubscribe-Post` with **Show original**.
6. Confirm a second address. After email 1, unsubscribe with the link in the email. Check that email 2 does not arrive.
7. On the **Welcome series** page, check the counts of **Contacts** and **Sent**.

## 18. The Workers plan setting (v0.3)

Expected result: on Free, welcome emails wait past 70% of the daily D1 writes, and campaigns and unsubscribes keep working.

1. On the Free deployment, open **Settings** > **Workers plan**. Check that **Workers Free** is selected.
2. Bring D1 past 70,000 rows written for the day. For example, import test addresses.
3. Confirm a signup to a list with a series that has a wait of 1 minute.
4. Check that the usage view shows the threshold and that the welcome email waits.
5. Send a campaign to one of your own addresses. Check that it sends.
6. Unsubscribe from the campaign. Check that the unsubscribe works.
7. After 00:00 UTC, check that the welcome email arrives.
8. Select **Workers Paid**, and select **Save plan**. Check that the usage view shows the plan as Paid. Set the plan back to **Workers Free**.

## 19. Gallery templates in real mail apps (v0.4)

Expected result: each template keeps its layout, logo, colors, and readable button labels in each mail app, with a dark brand and with a light brand.

1. In **Brand**, upload a PNG logo. Set **Primary color** to a dark color (for example `#1f2a44`) and **Accent color** to a light color (for example `#f4ead5`). Add a **Postal address** and two **Social links**.
2. Create a template from each of these gallery templates: **Newsletter**, **Product update**, **Event invite**, and **Plain letter**.
3. Send a test of each template to your Gmail address, your Outlook address, and an address that Apple Mail reads.
4. Open each email in Gmail on the web, in the Gmail app on a phone, in Outlook (desktop and web), and in Apple Mail on a Mac and an iPhone.
5. Check the logo, the brand colors, the font, the panel, the footer with the postal address, and the social links.
6. Check that each button label is easy to read on its button.
7. On a phone, check that the columns show one below the other. Record the indent of 12 px on stacked columns (a known issue).
8. Set **Primary color** to a light color (for example `#ffd84d`) and **Accent color** to a dark color (for example `#24323f`). Select **Save brand**.
9. Do steps 3 to 6 again. Check that button labels on the light color are dark.
10. Record each mail app and each problem, with a screenshot.

## 20. Logo response headers (v0.4)

Expected result: the logo URL returns the image with its stored type, `nosniff`, and a long cache time.

1. In **Brand**, copy the address of the current logo image.
2. Run `curl -sI "<logo-url>"`.
3. Check that `Content-Type` is the image type of the upload, for example `image/png`.
4. Check that the response has `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Cache-Control: public, max-age=31536000, immutable`.
5. Change one character of the hash in the URL, and run `curl -sI` again. Check that the response is 404 with `nosniff`.
6. Select **Replace logo**, and upload another file. Check that the old URL still returns the old image.

## 21. Confirm without a postal address (v0.4)

Expected result: the send checklist blocks the confirm until the brand kit has a postal address.

1. In **Brand**, clear **Postal address**, and select **Save brand**.
2. Create a draft campaign to a list that holds only your own address.
3. Select **Review and send**, then **Check and continue**.
4. Check that the check **Postal address** fails, and that the dialog does not let you send.
5. Select **Add the postal address in Brand**. Check that the **Brand** page opens.
6. Type the postal address, and select **Save brand**.
7. Check the send again. Check that **Postal address** passes and that the confirm works.
8. After the confirm, change the postal address in **Brand**. Check that the sent email shows the address from the time of confirm.

## 22. SMTP batch CPU on a deployed Free Worker (v0.5)

Expected result: an SMTP batch of 20 messages on Workers Free has p99 CPU time below about 8 ms, with no "Exceeded CPU time limit" error.

Envelopen v0.5 sends 20 SMTP messages per batch on Workers Free and 50 on Workers Paid. The local trial ran in the Workers runtime and in Node against mock servers. A warm 50-message batch used about 1 ms of client CPU. The first batch in a new isolate used about 8.6 ms, mostly JIT compilation. Real TLS, a real server, and the work of the queue consumer are not in those numbers.

1. Use the Free deployment. In **Settings** > **Workers plan**, check that **Workers Free** is selected.
2. Connect an SMTP server that you control and that delivers only to your own addresses. For example, use a test account at your SMTP provider.
3. Import 60 of your own test addresses. Use plus addresses, for example `you+1@gmail.com`.
4. Run `npx wrangler tail --format json` in a second terminal.
5. Send a campaign to the 60 addresses through the SMTP connection. Envelopen sends 3 batches of 20.
6. Read `cpuTime` of each queue invocation that sent a batch. Look for "Exceeded CPU time limit".
7. Do steps 5 and 6 two more times, with a pause of 10 minutes between them. Then at least one batch runs in a new isolate.
8. Record the highest `cpuTime`. If it is above about 8 ms, lower `SMTP_BATCH_SIZE_FREE` in `packages/providers/src/smtp/index.ts`.
9. Optional: select **Workers Paid** for one send, so that a batch has 50 messages. Record the `cpuTime`, then select **Workers Free** again. A Free account stops an invocation above 10 ms, so expect a possible error.
10. Record whether SMTP campaigns need Workers Paid.

## 23. Brevo keeps the unsubscribe headers (v0.5)

Expected result: `List-Unsubscribe` and `List-Unsubscribe-Post` arrive unchanged through the Brevo relay.

Send only to an address that you own. No automated test sends real email.

1. In Brevo, create an SMTP key. Verify your sending domain in Brevo.
2. Connect Brevo in Envelopen with the Brevo preset (`smtp-relay.brevo.com`, port 587).
3. Send a test campaign to a list that holds only your Gmail address.
4. In Gmail on the web, open the email, open the menu next to **Reply**, and select **Show original**.
5. Check that `List-Unsubscribe` holds the Envelopen `https` URL with `/u/` and a token.
6. Check that `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click`.
7. Check if Brevo added its own `List-Unsubscribe` value, or replaced the Envelopen value.
8. Record the result. If Brevo replaced the headers, the Brevo preset relies on Brevo's own unsubscribe header and the Brevo webhook (KTD13).

## 24. Brevo webhook with a bearer token (v0.5)

Expected result: Brevo sends each event with `Authorization: Bearer <token>`, and Envelopen stores the event with the right type.

1. Connect Brevo, and create the webhook with the `curl` command in the **Brevo events** dialog.
2. Run `npx wrangler tail --format json`.
3. Send a test campaign to a list with one of your own addresses and one address that does not exist at a domain that you own.
4. In the tail, find the POST to `/hooks/smtp/<workspace id>/<connection id>`. Check that it returns 200.
5. In the Brevo webhook logs, check that the request had the `Authorization` header. The URL must have no query string.
6. Record the body of one `hard_bounce` event. Check that it has `event`, `email`, `message-id`, and `ts_epoch` or `ts_event`.
7. Open the contact of the missing address. Check that Envelopen suppressed it with a hard bounce.
8. On the connection card, select **Set up the webhook**, then **Rotate the token**. Send again. Check that Brevo gets 401 until you update the webhook in Brevo.
9. Record whether Brevo sends one event per request, or a list of events.

## 25. Brevo keeps the Message-ID (v0.5)

Expected result: the `message-id` of a Brevo event is the `Message-ID` that Envelopen set, so bounces show on the campaign stats.

1. Send a test campaign through Brevo to your Gmail address and to one address that bounces.
2. In Gmail, open **Show original**. Record the `Message-ID` header.
3. In the Envelopen database, compare it with the provider message id of the recipient. Run `npx wrangler d1 execute <database name> --remote --command "SELECT provider_message_id FROM campaign_recipients ORDER BY id DESC LIMIT 5"`.
4. Compare the `message-id` of the bounce event in the tail (check 24) with the id of the bounced recipient.
5. Open the campaign. Check that **Bounced** counts the bounce.
6. Record the result. If Brevo replaced the `Message-ID`, the address is still suppressed, but the campaign stats miss the bounce. Update the [Brevo guide](provider-brevo.md).

## 26. Mailgun quota error text (v0.5)

Expected result: the error of a spent Mailgun quota pauses the campaign with "The provider's sending quota is used up", not a rate-limit retry.

1. Use a Mailgun Free account (100 emails per day). Do not set a daily sending limit on the connection.
2. Import 120 of your own test addresses.
3. Send a campaign to them through Mailgun.
4. Run `npx wrangler tail --format json`. Record the status code and the message of the first refused request.
5. Check that the campaign pauses with the reason "The provider's sending quota is used up".
6. If the campaign does not pause, add the words of the Mailgun message to `QUOTA_MESSAGE` in `packages/providers/src/mailgun/index.ts`.
7. Select **Daily limit** on the card, and set it to 100. Resume the campaign. Check that the confirm note and the campaign banner show the next sending day.

## 27. Mailgun webhook retries and the signature (v0.5)

Expected result: Mailgun signs each retry with a new timestamp and token, so Envelopen accepts a retry after an outage.

1. Connect Mailgun, and send a campaign to one of your own addresses.
2. Make the webhook fail for some minutes. For example, deploy a build that answers 500 on `/hooks/mailgun/*`, and send again.
3. Deploy the normal build again.
4. Wait for the first Mailgun retry (about 5 minutes later), and run `npx wrangler tail --format json`.
5. Check that the retry returns 200, and that the event shows on the campaign.
6. Record whether the retry has a new `timestamp` and `token`. If the retry reuses the old signature, Envelopen answers 401 (the timestamp is more than 5 minutes old, or the token is already used). Then update the [Mailgun guide](provider-mailgun.md#troubleshooting).

## 28. Mailgun EU region end to end (v0.5)

Expected result: a connection in the EU region sends through `api.eu.mailgun.net` and gets its events.

1. Use a Mailgun account in the EU region with a verified domain.
2. Connect Mailgun, and select the region **EU**.
3. Select the region **US** with the same key once. Check that the error says that Mailgun rejected the API key in the US region.
4. Send a test campaign to your Gmail address. In **Show original**, check the unsubscribe headers and that SPF, DKIM, and DMARC pass.
5. In the tail, check that the send went to `api.eu.mailgun.net`.
6. Check that the **Delivered** event arrives on the campaign.

## 29. Automatic Mailgun webhook with an API key (v0.5)

Expected result: Envelopen creates the webhook on the domain at connect, and removes only its own URL at remove.

1. In Mailgun, create an account API key (not a domain sending key).
2. Connect Mailgun with this key. Check that the card shows "Envelopen created the webhook".
3. In Mailgun, open **Send** > **Sending** > **Webhooks**. Check that the Envelopen URL is set for **Delivered messages**, **Permanent failure**, **Temporary failure**, **Spam complaints**, and **Unsubscribes**.
4. Add a second URL of your own for one event.
5. Remove the connection in Envelopen. Check that Mailgun keeps your own URL and removed the Envelopen URL.
6. Connect again with a domain sending key. Record whether the automatic setup fails, and whether the dialog shows the manual steps.

## Release process

A release is a `vX.Y.Z` tag on `main`. The release workflow (`.github/workflows/release.yml`) checks the tag, runs the checks, and creates the GitHub release. The update workflow in each copy then finds the release.

1. Do the checks in this guide that the release needs.
2. Set `version` in the root `package.json` to the new version, for example `0.2.0`. This file is the only place that holds the version.
3. In `CHANGELOG.md`, move the notes under **Unreleased** to a new section `## [0.2.0] - YYYY-MM-DD`.
4. If the owner must do something by hand, write it under **Manual steps**. Write changes that need a decision under **Breaking**.
5. Update the links at the end of `CHANGELOG.md`.
6. Commit the changes, and push them to `main`.
7. Wait for CI to pass.
8. Make the tag: `git tag v0.2.0`.
9. Push the tag: `git push origin v0.2.0`.
10. Open the **Release** workflow run, and check that it created the release with the notes.

Rules for each release:

- Never change or delete a D1 migration that a release shipped. Put each change in a new migration file. CI fails if a shipped migration changes (`scripts/check-migrations.mjs`).
- Never remove or reorder a Durable Object migration in `wrangler.jsonc`. Add new entries at the end.
- Use a tag that matches `version` in `package.json`. The release workflow fails on a mismatch.
- Do not move or delete a tag after the release. Copies compare their files with the tag of their version.

## Open questions to record

The plan leaves these questions for a deployed check. Record the answers here:

- The PBKDF2 iteration count that fits the Free CPU budget (check 2).
- The default batch size per adapter that fits 10 ms CPU (checks 3 and 4).
- Whether SES `{{{ }}}` renders a full HTML body safely in `SendBulkEmail`.
- Whether D1 calls count toward the 50 or the 1,000 subrequest limit on Free (check 4).
- Whether Cloudflare Email event subscriptions carry delivery events and work on Free.
- The bot-click time window, from real traffic.
- The TTL of confirm tokens and of the lease on claimed batches.
- The sweep timeout for `enqueued` batches, compared with the normal queue backlog on Free.
- Whether the Deploy button provisions the dead-letter queue on a Free account (check 1), and the Queues operation count for a 5,000-recipient campaign.
- The time and the CPU of the passphrase derivation on Free (check 14).
- Whether Turnstile in an iframe needs the hostname of the embedding website in the widget (check 15).
- Whether a 50-message SMTP batch fits 10 ms CPU on Free, and the SMTP batch size for Free (check 22).
- Whether the Brevo relay keeps both unsubscribe headers (check 23).
- The format of a Brevo webhook request, and whether Brevo keeps the `Message-ID` (checks 24 and 25).
- The text of a Mailgun quota error (check 26).
- Whether Mailgun signs each webhook retry again (check 27).

Last checked: 2026-10-22
