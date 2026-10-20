# Cloudflare Email Sending

Last checked: 2026-10-19

## What Envelopen uses it for

Envelopen sends test sends and system email (owner alerts) through the Cloudflare Email Sending REST API. Envelopen calls the API with your account ID and an API token. It does not use a `send_email` binding, so the Worker needs no extra binding.

Envelopen v1 receives no events from Cloudflare Email Sending. Cloudflare publishes events to a Cloudflare Queue, not to a webhook, and Envelopen v1 does not read that queue.

### Transactional-only policy

The Cloudflare Email Service FAQ says: "Email Service supports transactional email only." Envelopen marks the adapter as `transactional-only`. The adapter shows this warning:

> Cloudflare Email Sending supports transactional email only. Campaigns through it break Cloudflare's terms and can get sending turned off for your account.

This policy has these effects:

- System email and test sends always go through a Cloudflare Email connection. They do not need the warning.
- The send checklist blocks a campaign until the owner accepts the warning for the connection. The **Provider policy** item fails with: "Cloudflare Email Sending is a transactional-only provider. Accept its warning before you send a campaign through it."
- Only the owner can accept the warning, in the Envelopen app. An API key or an MCP agent cannot accept it.
- The audit log records who accepted the warning and when.

Do not send campaigns through Cloudflare Email Sending. Cloudflare's terms do not allow it. Use a campaign provider (Amazon SES, Resend, or Postmark).

## Cost and free tier

| Plan | What you get |
|---|---|
| Workers Free | No outbound sending, except to verified destination addresses of your account. |
| Workers Paid (5 USD per month) | 3,000 outbound emails per account per month. Then 0.35 USD per 1,000 emails. |

Email to verified destination addresses of your account is free on all plans. It does not count toward the quota.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Plan | Workers Paid on the account that sends | The connection card shows "Needs the Workers Paid plan." On Workers Free, only verified addresses of your account receive email. |
| Daily sending quota | New accounts start with a conservative quota. It grows with good sending history. You can request an increase. | Owner alerts are few, so the quota is rarely a problem. |
| Messages per call | The REST API sends one message per call. | Envelopen sends one call per recipient. One batch holds 25 recipients, with at most 5 calls at the same time. |
| Rate | Cloudflare publishes no sending rate. | The rate bucket charges per recipient and starts at 5 per second. |
| Message ID | The REST API returns no message ID. It returns lists of `delivered`, `permanent_bounces`, and `queued` addresses. | Envelopen records "sent" without a provider message ID. An address in `permanent_bounces` is recorded as not sent. |
| Recipients per email | 50 | Envelopen sends one recipient per email. |
| Message size | 5 MiB, including attachments | Envelopen email is much smaller. |
| Custom headers | 16 KB for all custom headers. Only allowlisted headers and `X-` headers are accepted. Any other header rejects the whole request. | `List-Unsubscribe`, `List-Unsubscribe-Post`, and `Auto-Submitted` are on the allowlist. |
| `List-Unsubscribe-Post` | Must be exactly `List-Unsubscribe=One-Click`, with an HTTPS URI in `List-Unsubscribe`. | Envelopen sends this value. |
| Sending domain | Must be a domain in your Cloudflare account, onboarded for Email Sending | Your DNS must be on Cloudflare. |
| Events | Published to a Cloudflare Queue: delivered, deferred, bounced, failed, rejected, and complained | Envelopen v1 does not read the queue. Bounces and complaints do not reach Envelopen, and the **Delivered** number shows "Not reported". |
| Suppression list | Cloudflare suppresses hard bounces and complaints for the account. | Cloudflare stops email to those addresses. Envelopen does not know about them. |
| Idempotency key | None | A timeout makes the batch uncertain. |

## When to choose it, and when not to

Choose it when:

- Your domain is on Cloudflare and you already pay for Workers Paid.
- You need a provider for owner alerts and test sends only.

Do not choose it when:

- You plan to send campaigns. Cloudflare's terms allow transactional email only.
- You use Workers Free.
- You need bounce and complaint events in Envelopen.

## Setup

1. Upgrade the Cloudflare account to Workers Paid.
2. In the Cloudflare dashboard, go to **Compute** > **Email Service** > **Email Sending**.
3. Select **Onboard Domain**. Select your sending domain and select **Done**.
4. Wait until the DNS records are active. Cloudflare adds MX, SPF, and DKIM records on the `cf-bounce` subdomain, and a DMARC record.
5. Create an API token with the **Email Sending: Edit** permission for the account.
6. Copy the API token and your account ID. The account ID is on the **Overview** page.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **Cloudflare Email Sending** and select **Connect**. The dialog shows the "Transactional-only provider" note.
3. Enter the **Account ID** and the **API token**.
4. Select **Connect**. Envelopen checks the token. It sends no email.
5. The card shows "This provider sends no events to Envelopen." Select **How events work** to read the details.
6. Open the **Sending domains** tab. Add your sending domain and check the DNS records.
7. Under **Send a test**, send a test to yourself.

There is no webhook to set up. Check bounces and complaints in the Cloudflare dashboard.

### Accept the policy warning

Envelopen lets the owner accept the warning, but Cloudflare's terms do not allow campaigns. If you accept it anyway, follow these steps:

1. On the connection card, select **Review the warning**.
2. Read the warning in the dialog "Use a transactional provider for campaigns?".
3. Select the checkbox "I understand the risk, and I take responsibility for campaigns sent through Cloudflare Email Sending."
4. Select **Accept the warning**.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Cloudflare rejected the API token. Check the token and the account ID." | The token is wrong, or the account ID does not match the token. | Check both values. Create a new token with **Email Sending: Edit**. |
| "The API token is ..." (not active) | The token is expired or disabled. | Create a new token. |
| Email reaches only verified addresses | The account is on Workers Free, or the domain is not onboarded. | Upgrade to Workers Paid. Onboard the sending domain. |
| A request fails with `E_HEADER_NOT_ALLOWED` | A header is not on the Cloudflare allowlist. | Use only allowlisted headers or `X-` headers. |
| A recipient shows "Cloudflare suppressed the address after an earlier bounce." | The address is on the Cloudflare suppression list. | Remove the address from your list. |
| Sending stops for the day | The daily quota is reached. | Wait for the quota to reset, or request a limit increase. |
| The send checklist fails on **Provider policy** | The owner did not accept the warning. | Connect a campaign provider and select **Use for sending**. |

## Sources

Last checked: 2026-10-19

- [Email Service FAQ (transactional only)](https://developers.cloudflare.com/email-service/reference/faq/)
- [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Send emails with the REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Get started: send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Email headers](https://developers.cloudflare.com/email-service/reference/headers/)
- [Event subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)
- [Suppressions](https://developers.cloudflare.com/email-service/concepts/suppressions/)
