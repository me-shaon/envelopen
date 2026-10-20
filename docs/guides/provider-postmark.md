# Postmark

Last checked: 2026-10-19

## What Envelopen uses it for

Envelopen sends campaigns, test sends, and system email (owner alerts) through the Postmark batch endpoint. All email goes through a **Broadcast** message stream. Postmark reports delivery, bounce, and spam complaint events to Envelopen through a webhook. Envelopen creates the webhook through the Postmark webhooks API.

The adapter policy is `campaign`. You can send campaigns through Postmark without a policy warning.

## Cost and free tier

| Plan | Price for 10,000 emails per month | Extra emails |
|---|---|---|
| Free (developer) | 0 USD for 100 emails per month. No overage. | Not available |
| Basic | 15.00 USD | 1.80 USD per 1,000 |
| Pro | 16.50 USD | 1.30 USD per 1,000 |
| Platform | 18.00 USD | 1.20 USD per 1,000 |

For higher volumes, Postmark asks you to contact sales. Broadcast streams appear on all plans on the pricing page.

Effect on Envelopen: the Free plan sends only 100 emails per month. Use it for tests, not for campaigns.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Message stream | Postmark supports bulk email only through a Broadcast message stream. | Envelopen sends every email through a Broadcast stream. If the server has no Broadcast stream, the connection fails. |
| Messages per batch request | 500 | Envelopen sends 50 messages per batch request, one recipient per message. |
| Batch payload size | 50 MB, including attachments | Campaign email is much smaller. |
| Recipients per message | 50 (To, CC, and BCC together) | Envelopen sends one recipient per message. |
| Batch response | HTTP 200 even when some messages fail. Each result has its own `ErrorCode` (0 is success). | Envelopen stores the result per recipient. A failed message does not stop the other messages. |
| Request rate | Postmark publishes no rate. | The rate bucket charges per request and starts at 10 batch requests per second. On a 429, Envelopen backs off. |
| Idempotency key | None | If a request times out, the batch becomes uncertain. Open the campaign page and select retry or skip for each uncertain batch. |
| Open and link tracking | Postmark can track opens and links. | Envelopen turns off Postmark tracking (`TrackOpens: false`, `TrackLinks: None`). Envelopen tracks opens and clicks itself. |
| Webhook signature | Postmark does not sign webhooks. It supports HTTP Basic auth on the webhook. | Envelopen sets Basic auth with the user name `envelopen` and a random password. It rejects a request without the correct credentials. |
| Webhook retries | Postmark retries 5xx, 408, 429, and network failures, 6 times over about 51 minutes. It does not retry other 4xx answers. | A short Envelopen outage does not lose events. |
| Server token | The webhooks API needs a server token. | Envelopen uses one server token for sending and for the webhook. |

### Unsubscribe handling and List-Unsubscribe headers

Envelopen adds two headers to every campaign and test email:

- `List-Unsubscribe` with the one-click URL and a `mailto` address.
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

Envelopen also adds its own unsubscribe link to the email body.

By default, Postmark manages unsubscribes on a Broadcast stream. In that mode, Postmark does these things:

- It adds its own one-click `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- It adds its own unsubscribe link to the bottom of each message.
- It keeps its own list of unsubscribed recipients.

The Postmark docs say: "There is not a way to edit the List-Unsubscribe headers when Postmark is managing your unsubscribes." So Envelopen's headers do not reach the recipient, and a one-click unsubscribe goes to Postmark, not to Envelopen. The contact then stays subscribed in Envelopen, and Postmark suppresses the address. Each message also shows two unsubscribe links.

To use Envelopen's headers, ask Postmark support to let you manage unsubscribes on your own for the Broadcast stream. Postmark support must turn this on. After that, Postmark sends the headers that Envelopen sets. Postmark then makes you responsible for these things:

- A working unsubscribe link in every broadcast message. Envelopen adds it.
- The correct List-Unsubscribe headers. Envelopen adds them.
- No email to people who unsubscribed. Envelopen suppresses them.
- A process that complies with the law.

Envelopen checks the stream when you connect and each time you select **Check**. If the stream does not use custom unsubscribe handling, the connection card shows this warning: "Postmark manages unsubscribes on this stream and replaces Envelopen's List-Unsubscribe headers. Ask Postmark support to turn on custom unsubscribe handling for the stream."

### Events

| Postmark webhook | Envelopen event |
|---|---|
| Delivery | Delivered |
| Bounce, type HardBounce, BadEmailAddress, or Blocked | Hard bounce |
| Bounce, type Transient, SoftBounce, or DnsError | Soft bounce |
| Spam complaint | Complaint |

Envelopen ignores other bounce types, such as auto-responders. Postmark reports no "failed" event to Envelopen.

## When to choose it, and when not to

Choose Postmark when:

- You want a provider with separate infrastructure for broadcast email.
- You already use Postmark for transactional email.

Do not choose Postmark when:

- You want the lowest price per email. SES and Resend cost less.
- You cannot contact Postmark support to turn on custom unsubscribe handling, and you need Envelopen to record one-click unsubscribes.

## Setup

1. Create a Postmark account, or sign in. Postmark reviews new accounts before they can send to all recipients.
2. Create a server, or open an existing server.
3. In the server, create a message stream of type **Broadcasts**. Note its ID (for example `broadcast`).
4. Add your sending domain under **Sender Signatures** or **Domains**. Add the DKIM and Return-Path records that Postmark shows.
5. Wait until Postmark shows the records as verified.
6. Contact Postmark support. Ask them to let you manage unsubscribes on your own for the Broadcast stream. Explain that Envelopen adds the unsubscribe link and the List-Unsubscribe headers.
7. Open the **API Tokens** tab of the server. Copy the server API token.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **Postmark** and select **Connect**.
3. Paste the **Server API token**.
4. Optional: enter the **Broadcast stream ID**. If you leave it empty, Envelopen uses the first Broadcast stream of the server.
5. Select **Connect**. Envelopen checks the token and finds the Broadcast stream. It sends no email.
6. Envelopen creates the webhook on the Broadcast stream. The card shows "Envelopen created the webhook".
7. If the card shows the unsubscribe warning, wait for Postmark support. Then select **Check**.
8. Open the **Sending domains** tab. Add your sending domain and check the DNS records.
9. Under **Send a test**, send a test to a Gmail address. Open **Show original**. Check that the `List-Unsubscribe` header contains your Envelopen URL.

### Manual setup

If the automatic setup fails, the **Set up the webhook** dialog shows these steps:

1. In Postmark, open the server, then the Broadcast stream, then **Webhooks**. Select **Add webhook**.
2. Paste the **Webhook URL** from the Envelopen dialog.
3. Turn on Basic auth credentials. Enter the user name `envelopen`.
4. Enter the **Webhook secret** from the Envelopen dialog as the password.
5. Select **Delivery**, **Bounce**, and **Spam complaint**, and save.

### Webhook URL

```
https://<your Envelopen address>/hooks/postmark/<workspace id>/<connection id>
```

The secret is in the Basic auth password, not in the URL.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Postmark rejected the server token." | The token is wrong, or it is an account token. | Copy the token from the **API Tokens** tab of the server. |
| "This server has no Broadcast message stream." | The server has only transactional streams. | Create a Broadcasts stream in the server. Connect again. |
| "This server has no Broadcast stream with the ID ..." | The stream ID is wrong, or the stream is archived. | Check the ID in Postmark, or leave the field empty. |
| The unsubscribe warning stays on the card | Postmark still manages unsubscribes on the stream. | Contact Postmark support. Select **Check** after they confirm the change. |
| Unsubscribes do not appear in Envelopen | Postmark manages unsubscribes, so the one-click request goes to Postmark. | Ask Postmark support for custom unsubscribe handling. Until then, check the Postmark suppression list. |
| The send fails for all recipients with an account message | Postmark has not approved the account yet. | Finish the Postmark account review. Then resume the campaign. |
| No events arrive | The webhook is on another stream, or Basic auth is wrong. | Open the Broadcast stream in Postmark. Check the webhook URL and the credentials. |
| Uncertain batches on the campaign page | A request timed out, and Postmark has no idempotency key. | Select retry or skip for each batch. A retry can send a second copy to some contacts. |

## Sources

Last checked: 2026-10-19

- [Can I send bulk emails?](https://postmarkapp.com/support/article/can-i-send-bulk-emails)
- [Email API (batch endpoint)](https://postmarkapp.com/developer/api/email-api)
- [Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)
- [Webhooks overview (retries and protection)](https://postmarkapp.com/developer/webhooks/webhooks-overview)
- [How to include a List-Unsubscribe header](https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header)
- [Managing your own unsubscribe process](https://postmarkapp.com/support/article/managing-your-own-unsubscribe-process)
- [Message streams API](https://postmarkapp.com/developer/api/message-streams-api)
- [Bounce API (bounce types)](https://postmarkapp.com/developer/api/bounce-api)
- [Pricing](https://postmarkapp.com/pricing)
