# Resend

Last checked: 2026-10-19

## What Envelopen uses it for

Envelopen sends campaigns, test sends, and system email (owner alerts) through the Resend batch endpoint. Resend reports delivery, bounce, complaint, and failure events to Envelopen through a webhook. Envelopen creates the webhook through the Resend webhook API.

The adapter policy is `campaign`. You can send campaigns through Resend without a policy warning.

## Cost and free tier

Envelopen sends through the `/emails` API. Resend counts each recipient of an `/emails` send as one email against the transactional quota of your plan. The Resend Marketing plans (priced by contacts) apply to Resend Broadcasts, which Envelopen does not use.

| Plan | Price | Emails | Daily limit | Domains |
|---|---|---|---|---|
| Free | 0 USD | 3,000 per month | 100 per day | 3 |
| Pro | From 20 USD per month | From 50,000 per month | None | 10 |
| Scale | From 90 USD per month | From 100,000 per month | None | 1,000 |

Effect on Envelopen: on the Free plan, a campaign to more than 100 contacts stops at the daily limit. Envelopen pauses the campaign. Resume it after 00:00 UTC, or upgrade the plan.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Emails per batch request | 100 | Envelopen sends 50 emails per batch request, one recipient per email. |
| Rate limit | 10 requests per second per team, shared by all API keys of the team | Each batch is one request. The rate bucket charges per request and starts at 10 per second. On a 429, Envelopen backs off and uses `Retry-After`. |
| Daily quota (Free plan) | 100 emails per UTC day. Error `daily_quota_exceeded`. | Envelopen pauses the campaign. |
| Monthly quota | Set by your plan. Error `monthly_quota_exceeded`. | Envelopen pauses the campaign. |
| Idempotency key | Up to 256 characters. Resend keeps it for 24 hours. The batch endpoint supports it. | Envelopen stores one key per batch at the first claim. A retry sends the same key and the same payload, so Resend does not send twice. After 24 hours, the batch becomes uncertain. |
| Batch validation | The `x-batch-validation: permissive` header returns accepted emails in `data` and rejected emails in `errors`. | Envelopen sends in permissive mode. One bad address does not stop the other emails in the batch. |
| Attachments in a batch | Not supported | Envelopen does not send attachments. |
| Custom headers | Supported | Envelopen sends `List-Unsubscribe` and `List-Unsubscribe-Post` unchanged. |
| Webhook signature | Svix: `svix-id`, `svix-timestamp`, and `svix-signature` headers. The signing secret starts with `whsec_`. | Envelopen verifies each request with WebCrypto. It rejects a request with a wrong signature. |
| Webhook retries | Resend retries a failed delivery for about 27 hours (after 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, and 10 hours). Then it disables the endpoint. | A short Envelopen outage does not lose events. |
| API key permission | `full_access` or `sending_access` | A Full access key lets Envelopen create the webhook. A Sending access key can only send. |

### Events

Envelopen subscribes to these Resend events:

| Resend event | Envelopen event |
|---|---|
| `email.delivered` | Delivered |
| `email.bounced` with bounce type `Permanent` | Hard bounce |
| `email.bounced` with another bounce type | Soft bounce |
| `email.complained` | Complaint |
| `email.failed` | Failed |

A hard bounce or a complaint suppresses the address in Envelopen at once. Opens and clicks come from Envelopen tracking, not from Resend.

## When to choose it, and when not to

Choose Resend when:

- You want a fast setup with one API key.
- You want safe retries. Resend is the only v1 provider with an idempotency key.
- You send fewer than 100 emails per day (Free plan) or you pay for Pro or Scale.

Do not choose Resend when:

- You want the lowest price per email at high volume. SES costs less.
- You send more than 100 emails per day and do not want a paid plan.

## Setup

1. Create a Resend account at https://resend.com, or sign in.
2. Go to **Domains** and add your sending domain.
3. Add the DNS records that Resend shows (DKIM, SPF on the `send` subdomain, and MX for bounces).
4. Wait until Resend shows the domain as verified.
5. Go to **API Keys** and create a key with **Full access**.
6. Copy the API key. It starts with `re_`.

If you must use a **Sending access** key, Envelopen cannot create the webhook. Follow the manual steps after you connect.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **Resend** and select **Connect**.
3. Paste the **API key**.
4. Select **Connect**. Envelopen checks the key with a call that sends no email.
5. Envelopen creates the webhook. The card shows "Envelopen created the webhook".
6. Open the **Sending domains** tab. Add your sending domain. Envelopen reads the DNS records from Resend.
7. Under **Send a test**, select a from address and send a test to yourself.

### Manual setup (Sending access key)

The card shows "This key can only send". The **Set up the webhook** dialog opens.

1. In the Resend dashboard, open **Webhooks** and select **Add Webhook**.
2. Paste the **Webhook URL** from the Envelopen dialog as the endpoint URL.
3. Select the events `email.delivered`, `email.bounced`, `email.complained`, and `email.failed`.
4. Save the webhook. Copy its signing secret (it starts with `whsec_`).
5. In the Envelopen dialog, paste the secret into **Signing secret from the provider**.
6. Select **Save secret**.

### Webhook URL

```
https://<your Envelopen address>/hooks/resend/<workspace id>/<connection id>
```

The URL carries no secret. The Svix signature proves that the request comes from Resend.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Resend rejected the API key." | The key is wrong, revoked, or from another team. | Create a new key and connect again. |
| "This key can only send." | The key has Sending access. | Use the manual steps, or connect again with a Full access key. |
| The campaign pauses after 100 emails | The Free plan daily limit is reached. | Resume after 00:00 UTC, or upgrade to Pro. |
| The campaign pauses with a monthly quota message | The plan's monthly emails are used up. | Upgrade the plan, or wait for the next billing month. |
| Webhook requests fail with 401 | The signing secret in Envelopen does not match the webhook. | Copy the secret from the webhook in Resend. Paste it in **Replace the signing secret**. |
| Resend disabled the webhook | Envelopen did not answer for about a day. | Fix the outage. Enable the webhook again on the Resend **Webhooks** page. Replay the failed events. |
| Some recipients show "not sent" with a validation message | Resend rejected those emails in permissive mode. | Read the message. Fix the address or the content. |

## Sources

Last checked: 2026-10-19

- [Send batch emails](https://resend.com/docs/api-reference/emails/send-batch-emails)
- [Batch validation modes](https://resend.com/docs/dashboard/emails/batch-validation-modes)
- [Idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Rate limit](https://resend.com/docs/api-reference/rate-limit)
- [Pricing](https://resend.com/pricing)
- [Create API key (permissions)](https://resend.com/docs/api-reference/api-keys/create-api-key)
- [Create webhook](https://resend.com/docs/api-reference/webhooks/create-webhook)
- [Webhook event types](https://resend.com/docs/dashboard/webhooks/event-types)
- [Verify webhook requests](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests)
- [Webhook retries and replays](https://resend.com/docs/webhooks/retries-and-replays)
