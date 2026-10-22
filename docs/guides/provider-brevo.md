# Brevo

Last checked: 2026-10-22

## What Envelopen uses it for

Envelopen sends campaigns, welcome emails, confirmation emails, test sends, and system email through the Brevo SMTP relay. Brevo is a preset of the SMTP connection. See [SMTP](provider-smtp.md) for the SMTP rules that apply to every preset.

Brevo reports bounces, complaints, and unsubscribes to Envelopen through a transactional webhook:

| Brevo event | Envelopen result |
|---|---|
| `hard_bounce` | Hard bounce. Envelopen suppresses the address. |
| `invalid_email` | Hard bounce. Envelopen suppresses the address. |
| `soft_bounce` | Soft bounce. |
| `spam` | Complaint. Envelopen suppresses the address. |
| `blocked` | Failed. Brevo did not send the message, because the address is on a Brevo block list. |
| `unsubscribed` | Envelopen unsubscribes the contact from every list. The source is `provider:smtp`. |

Envelopen ignores other events, such as opens and clicks. Envelopen tracks opens and clicks itself.

### How the webhook proves that a request comes from Brevo

Brevo does not sign its webhooks. Envelopen uses a bearer token for each connection:

- Envelopen makes a random token when you connect Brevo. It stores the token encrypted and bound to the connection.
- Brevo sends the token in the `Authorization: Bearer` header. The webhook URL holds no secret. A request with the token in the URL is refused.
- Envelopen compares the token in constant time.
- You can rotate the token on the connection page. The old token stops working at once.
- Envelopen accepts at most 600 verified requests per minute for each connection. Above that, it answers 429, and Brevo can send the request again later.

## Cost and free tier

- The Brevo free plan sends 300 emails per day (Brevo pricing page, checked 2026-10-22).
- Paid plans remove the daily limit and set a monthly volume. Check your plan in Brevo.
- Envelopen adds no cost.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Daily limit of the free plan | 300 emails per day. | The Brevo preset sets a daily limit of 300. Change it to the limit of your plan. |
| Daily limit enforcement | Envelopen counts the emails of the connection in the last 24 hours. | A campaign larger than the limit sends over several days. Welcome and confirmation emails share the limit. See [Daily sending limits and multi-day sends](provider-smtp.md#daily-sending-limits-and-multi-day-sends). |
| SMTP login | The login on the **SMTP & API** page, usually your Brevo account address. | Enter it as the **SMTP login**. |
| SMTP key | A key from the **SMTP & API** page. It is not your Brevo password, and it is not an API key. | Enter it as the **SMTP key**. |
| Messages per batch | 20 on Workers Free, 50 on Workers Paid (Envelopen trial 1). | Set the Workers plan in **Settings**. |
| Idempotency | SMTP has no idempotency key. | If a batch times out, the batch becomes uncertain. Select retry or skip on the campaign page. |
| Webhook setup | Brevo documents bearer authentication for the webhook API (checked 2026-10-22). | Create the webhook once with the `curl` command in the Envelopen dialog. Envelopen cannot create it, because the SMTP key cannot call the Brevo API. The owner checks the delivery (release checklist, check 24). |
| Event ids | Brevo sends no unique event id. | Envelopen builds an id from the event name, the message id, the address, and the time. A replay is stored once. |
| Message ids | Envelopen sets the `Message-ID` header. | Envelopen matches events to campaign recipients by this id, if Brevo keeps it. The owner checks this (release checklist, check 25). |
| Unsubscribe headers | Envelopen sends `List-Unsubscribe` and `List-Unsubscribe-Post`. | The owner checks that Brevo keeps both headers (release checklist, check 23). |
| Sender domain | Brevo sends only from a verified sender or domain. | Verify your sending domain in Brevo, and add it in Envelopen too. |

If check 23 shows that Brevo replaces the unsubscribe headers, Envelopen will rely on the Brevo unsubscribe link and the `unsubscribed` webhook event for this preset. The `unsubscribed` event already unsubscribes the contact in Envelopen.

## When to choose it, and when not to

Choose Brevo when:

- You want a free plan for a small list, with bounce and complaint events.
- You want a relay that accepts newsletters.

Do not choose Brevo when:

- You send more than 300 emails per day and do not want a paid plan.
- You do not want to run one `curl` command to create the webhook.

## Setup

1. Create an account at https://www.brevo.com.
2. In the Brevo settings, add your sending domain. Add the DNS records that Brevo shows, and wait for verification.
3. Open **SMTP & API**, then **SMTP**. Copy the **Login**.
4. Select **Generate a new SMTP key**. Copy the key.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **SMTP** and select **Connect**.
3. Under **Service**, select **Brevo**.
4. Enter the **SMTP login** and the **SMTP key**.
5. Set the **Daily sending limit** to the limit of your Brevo plan. See [Daily sending limits and multi-day sends](provider-smtp.md#daily-sending-limits-and-multi-day-sends).
6. Select **Connect**. Envelopen signs in to `smtp-relay.brevo.com` and sends QUIT. It sends no email.
7. The **Brevo events** dialog opens. It shows the **Webhook URL**, the **Bearer token**, and the steps.
8. Create the webhook. Follow the steps below.
9. Open the **Sending domains** tab. Add your sending domain.
10. Under **Send a test**, send a test to yourself.

### Create the webhook

1. In Brevo, open **SMTP & API**, then **API keys**. Create an API key for this step.
2. Copy the `curl` command from the **Brevo events** dialog.
3. Replace `YOUR_API_KEY` with the API key.
4. Run the command once in a terminal.
5. Delete the API key in Brevo, if you do not need it for other work.

The command creates a transactional webhook with these settings:

```
POST https://api.brevo.com/v3/webhooks
{
  "type": "transactional",
  "url": "https://<your Envelopen address>/hooks/smtp/<workspace id>/<connection id>",
  "events": ["hardBounce", "softBounce", "invalid", "blocked", "spam", "unsubscribed"],
  "auth": { "type": "bearer", "token": "<the bearer token>" }
}
```

### Rotate the token

1. On the connection card, select **Set up the webhook**.
2. Select **Rotate the token**. The old token stops working at once.
3. Copy the new **Bearer token**.
4. Update the webhook in Brevo with `PUT /v3/webhooks/{id}` and the new `auth` object. Or delete the webhook and run the `curl` command again.

Events that Brevo sends between step 2 and step 4 get a 401. Brevo can send them again later.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "SMTP 535 ..." on connect | The SMTP key or the login is wrong. | Copy both again from **SMTP & API**. Do not use your Brevo password or an API key. |
| The test email does not arrive | The From address is not a verified Brevo sender. | Verify the domain in Brevo. Check the Brevo **Transactional** logs. |
| Webhook requests get 401 | The token in Brevo is old, or Brevo sends no `Authorization` header. | Rotate the token, then update the webhook in Brevo with the new token. |
| Webhook requests get 404 | The URL is wrong, or it has the token as a path segment. | Copy the **Webhook URL** again. Put the token only in the `auth` object. |
| Webhook requests get 429 | More than 600 requests per minute reached the connection. | Wait. Brevo can send the request again later. |
| Bounces show, but not on the campaign stats | Brevo replaced the `Message-ID`. | The address is still suppressed. Report the result with release check 25. |
| The campaign pauses with a quota message | The Brevo plan reached its limit before the Envelopen limit. | Wait for the reset or upgrade the plan, then resume the campaign. Select **Daily limit** on the card, and set the limit of your plan. |

## Sources

Last checked: 2026-10-22

- [Brevo pricing](https://www.brevo.com/pricing/)
- [Brevo free SMTP server](https://www.brevo.com/free-smtp-server/)
- [Brevo transactional webhooks (events and fields)](https://developers.brevo.com/docs/transactional-webhooks)
- [Brevo secured webhooks (bearer token)](https://developers.brevo.com/docs/secured-webhooks)
- [Brevo create a webhook API](https://developers.brevo.com/reference/create-webhook)
