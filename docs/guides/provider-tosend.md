# toSend

Last checked: 2026-10-19

## What Envelopen uses it for

Envelopen sends test sends and system email (owner alerts) through the toSend batch API. toSend reports bounces and complaints to Envelopen through a signed webhook.

### Transactional-only policy

Envelopen marks the toSend adapter as `transactional-only`. toSend presents itself as a service for transactional email, such as receipts, password resets, and form notifications. The adapter shows this warning:

> Envelopen treats toSend as a transactional provider. Campaigns through it can break the provider's terms or hurt your sender reputation. toSend allows marketing email only to people who asked for it, with a visible unsubscribe link in the body.

This policy has these effects:

- System email and test sends always go through a toSend connection. They do not need the warning.
- The send checklist blocks a campaign until the owner accepts the warning for the connection. The **Provider policy** item fails with: "toSend is a transactional-only provider. Accept its warning before you send a campaign through it."
- Only the owner can accept the warning, in the Envelopen app. An API key or an MCP agent cannot accept it.
- The audit log records who accepted the warning and when.

If you plan to send campaigns, ask toSend first whether they allow your newsletter. Choose a campaign provider (Amazon SES, Resend, or Postmark) if you can.

## Cost and free tier

- 0.30 USD per 1,000 emails. There is one price, with no tiers.
- No subscription and no monthly minimum.
- New accounts get 10,000 credits. You do not need a card to sign up.
- Top-ups start at 10 USD. Credits do not expire.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Emails per batch request | 1 to 100 | Envelopen sends 50 emails per batch request, one recipient per email. |
| Rate limit | 10 batch requests per second per team, over a 10-second window. 429 with `Retry-After` when exceeded. | The rate bucket charges per request and starts at 10 per second. On a 429, Envelopen backs off. |
| Batch response | 200 when all emails are accepted. 207 when some fail. Each result has `status` (`success`, `error`, or `spam`). | Envelopen stores the result per recipient. A failed email does not stop the other emails. |
| Credits | toSend counts the recipients of the whole batch first. If the balance is too low, the whole request fails with 403. | Envelopen pauses the campaign. Add credits and resume it. |
| Idempotency key | None | If a request times out, the batch becomes uncertain. Open the campaign page and select retry or skip for each uncertain batch. |
| Webhook events | `bounced` and `complaint` only. No delivery event. | The **Delivered** number in the campaign stats shows "Not reported". The other numbers show normally. Opens and clicks come from Envelopen tracking. |
| Webhook retries | None. toSend sends each event once. It logs a failure after a non-2xx answer or after 10 seconds. | If Envelopen is down, the events of that time are lost. Check the toSend **Logs** page (kept 14 days) and the toSend suppression list. |
| Webhook signature | `X-ToSend-Signature: sha256=<hex>`, an HMAC-SHA256 of the raw body. toSend sends it only when the webhook has a secret. | Envelopen rejects a request without a valid signature. Always set a secret. |
| API key types | Sending keys start with `tsend_`. Admin keys start with `tsend_admin_`. | An admin key with `webhooks:write` lets Envelopen create the webhook. An admin key also needs `emails:send` to send. |
| Automatic suppression | toSend suppresses bounced and complaining addresses. It blocks disposable addresses before it sends. | Envelopen keeps its own suppression list too. Both lists apply. |
| Custom headers | Supported | Envelopen sends `List-Unsubscribe` and `List-Unsubscribe-Post` unchanged. |

## When to choose it, and when not to

Choose toSend when:

- You need a provider for owner alerts and test sends only.
- You want a simple pay-as-you-go price with no subscription.

Do not choose toSend when:

- You plan to send campaigns. Use a campaign provider.
- You need delivery counts in your campaign stats.
- You cannot accept lost bounce events during an outage.

## Setup

1. Create an account at https://tosend.com.
2. Add your sending domain. Add the DKIM, SPF, and MX records that toSend shows.
3. Wait until toSend shows the domain as verified.
4. Create an API key. For automatic webhook setup, create an admin key with the scopes `emails:send` and `webhooks:write`.
5. Copy the API key.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **toSend** and select **Connect**. The dialog shows the "Transactional-only provider" note.
3. Paste the **API key**.
4. Select **Connect**. Envelopen checks the key with `GET /v2/info`. It sends no email.
5. With an admin key, Envelopen creates the webhook. The card shows "Envelopen created the webhook".
6. With a sending key, the **Set up the webhook** dialog opens. Follow the manual steps below.
7. Open the **Sending domains** tab. Add your sending domain and check the DNS records.
8. Under **Send a test**, send a test to yourself.

### Accept the policy warning (only for campaigns)

1. On the connection card, find the note "Campaigns are blocked on this connection".
2. Select **Review the warning**.
3. Read the warning in the dialog "Use a transactional provider for campaigns?".
4. Select the checkbox "I understand the risk, and I take responsibility for campaigns sent through toSend."
5. Select **Accept the warning**.

The card then shows the date of acceptance.

### Manual setup

1. In the toSend dashboard, open **Webhooks** and select **Create Webhook**.
2. Paste the **Webhook URL** from the Envelopen dialog.
3. Set the secret to the **Webhook secret** from the Envelopen dialog.
4. Select the **Bounced** and **Complaint** events.
5. Do not limit the webhook to one domain, unless you send from that domain only.
6. Select **Create Webhook**.

### Webhook URL

```
https://<your Envelopen address>/hooks/tosend/<workspace id>/<connection id>
```

The secret is not in the URL. The `X-ToSend-Signature` header proves that the request comes from toSend.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "toSend rejected the API key." | The key is wrong or disabled. | Create a new key and connect again. |
| The send checklist fails on **Provider policy** | The owner did not accept the warning. | Select **Open connections**, then **Review the warning**. Or connect a campaign provider. |
| The card shows "The toSend account has no credits left." | The balance is 0. | Add credits in toSend. Select **Check**. |
| The campaign pauses with a credits message | The balance cannot cover the whole batch. | Add credits, then resume the campaign. |
| Webhook requests fail with 401 | The secret in toSend does not match, or no secret is set. | Set the same secret in toSend and Envelopen. |
| Bounces are missing after an outage | toSend does not retry webhooks. | Check the toSend **Logs** page and the suppression list. Suppress the addresses in Envelopen. |
| "Delivered" shows "Not reported" | toSend sends no delivery events. | This is expected. |

## Sources

Last checked: 2026-10-19

- [toSend home page](https://tosend.com/)
- [API introduction (keys, rate limits, errors)](https://tosend.com/docs/api/introduction/)
- [Batch emails API](https://tosend.com/docs/api/batch-emails/)
- [Webhooks guide](https://tosend.com/docs/guide/webhooks/)
- [Admin API (scopes and webhooks)](https://tosend.com/docs/api/admin-api/)
- [Pricing](https://tosend.com/pricing)
