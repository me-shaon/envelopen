# Mailgun

Last checked: 2026-10-22

## What Envelopen uses it for

Envelopen sends campaigns, test sends, and system email (owner alerts) through the Mailgun HTTP API. Mailgun reports deliveries, bounces, complaints, and unsubscribes to Envelopen through a webhook. Envelopen creates the webhook through the Mailgun webhooks API.

The adapter policy is `campaign`. You can send campaigns through Mailgun without a policy warning.

Envelopen works with accounts in both Mailgun regions:

| Region | API base URL |
|---|---|
| US | `https://api.mailgun.net` |
| EU | `https://api.eu.mailgun.net` |

An account and its domains are in one region. Select the region of your account when you connect.

## Cost and free tier

| Plan | Price per month | Emails included | Extra emails |
|---|---|---|---|
| Free | 0 USD | 100 emails per day | Not available |
| Basic | From 15 USD | 10,000 per month | From 1.80 USD per 1,000 |
| Foundation | 35 USD (first month free) | 50,000 per month | From 1.30 USD per 1,000 |
| Scale | 90 USD (first month free) | 100,000 per month | From 1.10 USD per 1,000 |

Effect on Envelopen: the Free plan sends 100 emails per day. On that plan, set the **Daily limit** of the connection to 100. Envelopen then spreads a larger campaign over several days.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Recipients per batch call | 1,000, with recipient variables | Envelopen does not use batch calls. See [Why one request per recipient](#why-one-request-per-recipient). |
| Requests per batch | One request per recipient | Envelopen sends 25 recipients per batch, 5 requests at a time. This stays inside the 50 subrequests of Workers Free. |
| Request rate | Mailgun publishes no fixed rate. A 429 answer has `X-RateLimit-Reset` in Unix milliseconds. | Envelopen starts at 10 emails per second. On a 429, it stops the batch and waits until the reset time. |
| Daily sending limit | 100 emails per day on the Free plan | A sending-limit error pauses the campaign as a quota error. Set the daily limit of the connection to avoid it. |
| Idempotency key | None | If a request times out, that recipient becomes uncertain. Open the campaign page and select retry or skip for each uncertain batch. |
| Open and click tracking | Mailgun can track opens and clicks. | Envelopen turns off Mailgun tracking (`o:tracking`, `o:tracking-opens`, and `o:tracking-clicks` set to `no`). Envelopen tracks opens and clicks itself. |
| Custom headers | `h:` fields of the send call | Envelopen sends `h:List-Unsubscribe` and `h:List-Unsubscribe-Post` with each email. |
| Webhook signature | HMAC-SHA256 of the timestamp and a 50-character token, with the account's HTTP webhook signing key | The signature does not cover the event data. See [Webhook security](#webhook-security). |
| Webhook retries | Mailgun retries a failed webhook for 8 hours, after 5 minutes, 10 minutes, 15 minutes, 1 hour, 2 hours, and 4 hours. A 200 or a 406 answer stops the retries. | A short Envelopen outage does not lose events, if Mailgun signs each retry again. See [Troubleshooting](#troubleshooting). |
| Sandbox domain | Sends only to authorized recipients | The connection works, and the card shows a warning. Add your own domain for campaigns. |

### Why one request per recipient

Mailgun's batch sending takes up to 1,000 recipients in one call. The email is a template with `%recipient.<key>%` placeholders, and `recipient-variables` holds the values for each address. Envelopen does not use it, for these reasons:

- Envelopen personalizes each email before the send. Each recipient has different HTML: merge fields, signed tracking links, and the unsubscribe link. A template with placeholders cannot carry that exactly, unless each full body goes in a variable. One call with 1,000 bodies can pass Mailgun's message size limit.
- Each recipient has a different `List-Unsubscribe` URL. Mailgun documents placeholders in the subject, the body, and the `To` header. It does not document them in custom headers.
- A batch call returns one message id for all recipients. Envelopen needs one id per recipient to match events to recipients.

So each recipient gets one call to `POST /v3/<domain>/messages`, with the personalized HTML and both unsubscribe headers. The result of each call is the result of that recipient.

### Webhook security

Mailgun signs the timestamp and a random token. It does not sign the event data. Envelopen does these checks on each request:

1. It computes HMAC-SHA256 of `timestamp + token` with the signing key, and compares the result in constant time.
2. It rejects a timestamp that is more than 5 minutes before or after the clock.
3. It records the token in D1 (the `webhook_nonces` table) before it stores anything. If the token is already there, Envelopen answers 401 and records nothing. This stops a captured signature from carrying a changed event. D1 does this in one atomic insert. KV is eventually consistent, so Envelopen does not use it for this check.
4. It stores each event once, by the Mailgun event id (unique in `provider_events`).

The retention job deletes tokens after their 5-minute window.

The signing key is encrypted like the other credentials, and bound to the connection.

### Events

| Mailgun event | Envelopen event |
|---|---|
| `delivered` | Delivered |
| `failed`, severity `permanent` | Hard bounce. Envelopen suppresses the address at once. |
| `failed`, severity `temporary` | Soft bounce |
| `failed`, severity `permanent`, reason `old` | Soft bounce. Mailgun stopped its retries, but the address can work later. |
| `failed`, severity `permanent`, reason `suppress-complaint` | Complaint |
| `failed`, severity `permanent`, reason `suppress-unsubscribe` | Unsubscribe of the contact from every list |
| `complained` | Complaint. Envelopen suppresses the address at once. |
| `unsubscribed` | Unsubscribe of the contact from every list |

Envelopen ignores other events, such as `accepted`, `opened`, and `clicked`.

## When to choose it, and when not to

Choose Mailgun when:

- You already use Mailgun, or your data must stay in the EU region.
- You want a campaign provider with a webhook for bounces and complaints, and a dashboard for logs.

Do not choose Mailgun when:

- You want the lowest price per email. SES costs less.
- You send more than 100 emails per day and do not want a paid plan.
- You want an idempotency key, so a timed-out request can retry with no risk of a second copy. Resend has one.

## Setup

1. Create a Mailgun account, or sign in. Note the region of the account (US or EU).
2. Open **Send**, then **Sending**, then **Domains**. Add your sending domain, for example `mg.example.com`.
3. Add the SPF, DKIM, and MX records that Mailgun shows at your DNS host. Wait until Mailgun shows the domain as verified.
4. Open **API Security** (under your account settings). Create an API key and copy it. A domain sending key can send, but it cannot create the webhook.
5. On the same page, copy the **HTTP webhook signing key**. It is not the API key.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **Mailgun** and select **Connect**.
3. Paste the **API key**.
4. Enter the **Sending domain** as Mailgun lists it.
5. Select the **Region** of your Mailgun account: **US** or **EU**.
6. Paste the **HTTP webhook signing key**.
7. Select **Connect**. Envelopen reads the domain from the API of the region to check the key and the domain. It sends no email.
8. Envelopen creates the webhook for the events `delivered`, `permanent_fail`, `temporary_fail`, `complained`, and `unsubscribed`. The card shows "Envelopen created the webhook".
9. On the Free plan, select **Daily limit** on the card and set it to 100.
10. Open the **Sending domains** tab. Add your sending domain and check the DNS records.
11. Under **Send a test**, send a test to a Gmail address. Open **Show original**. Check that the `List-Unsubscribe` and `List-Unsubscribe-Post` headers contain your Envelopen values.

### Manual setup

If the automatic setup fails, the **Set up the webhook** dialog shows these steps. Envelopen keeps the signing key from the connect form, so you do not paste it again.

1. In Mailgun, open **Send**, then **Sending**, then **Webhooks**. Select your sending domain.
2. Add the **Webhook URL** from the Envelopen dialog for these events: **Delivered messages**, **Permanent failure**, **Temporary failure**, **Spam complaints**, and **Unsubscribes**.

### Webhook URL

```
https://<your Envelopen address>/hooks/mailgun/<workspace id>/<connection id>
```

The URL has no secret. Envelopen checks the signature of each request with the signing key.

When you remove the connection, Envelopen removes only its own URL from the Mailgun webhooks. Other webhooks of the domain stay.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Mailgun rejected the API key in the US region." | The key is wrong, or the account is in the EU region. | Check the key. Select the EU region for an EU account. |
| "Mailgun has no domain ... in the EU region." | The domain name is wrong, or the domain is in the other region. | Check the domain under **Domains** in Mailgun. Select the other region. |
| The card warns about a sandbox domain | The domain is the Mailgun sandbox domain. | Add your own domain in Mailgun, and connect again with it. |
| The card says that Mailgun shows the domain as unverified | The DNS records are not in place yet. | Add the records that Mailgun shows. Then select **Check**. |
| The campaign pauses with a quota error | The account reached its sending limit, for example 100 emails per day on the Free plan. | Set the daily limit of the connection, or upgrade the plan. Then resume the campaign. |
| No events arrive, and the webhook log in Mailgun shows 401 | The signing key in Envelopen is not the current HTTP webhook signing key. Or Mailgun retried an event with a signature that is more than 5 minutes old. | Check the key in **API Security**. For a manual setup, paste it in the **Set up the webhook** dialog. For an automatic setup, remove the connection and connect again. |
| Events stop after you rotate the signing key in Mailgun | The old key is still in Envelopen. | Remove the connection and connect again with the new key. For a manual setup, you can paste the new key in the **Set up the webhook** dialog. |
| Uncertain batches on the campaign page | A request timed out, and Mailgun has no idempotency key. | Select retry or skip for each batch. A retry can send a second copy to some contacts. |

## Sources

Last checked: 2026-10-22

- [API overview (base URLs, errors, rate limit headers)](https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview)
- [Batch sending (1,000 recipients, recipient variables)](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/batch-sending)
- [Securing webhooks (signature, token, timestamp)](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks)
- [Webhook retries](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-retries)
- [Create domain webhooks (v4)](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domain-webhooks/post-v4-domains--domain--webhooks)
- [Delete domain webhooks (v4)](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domain-webhooks/delete-v4-domains--domain--webhooks)
- [Event structure](https://documentation.mailgun.com/docs/mailgun/user-manual/events/event-structure)
- [Pricing](https://www.mailgun.com/pricing/)
