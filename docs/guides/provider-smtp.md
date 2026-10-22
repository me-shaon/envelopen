# SMTP (Gmail, Google Workspace, and custom servers)

Last checked: 2026-10-22

## What Envelopen uses it for

Envelopen sends campaigns, welcome emails, confirmation emails, test sends, and system email through an SMTP server. The SMTP connection has four presets:

| Preset | Server | Default daily limit | Bounce events |
|---|---|---|---|
| **Gmail** | `smtp.gmail.com`, port 587, STARTTLS | 500 | No |
| **Google Workspace** | `smtp.gmail.com`, port 587, STARTTLS | 2,000 | No |
| **Brevo** | `smtp-relay.brevo.com`, port 587, STARTTLS | 300 | Yes, through the Brevo webhook. See [Brevo](provider-brevo.md). |
| **Custom SMTP** | Any host. Port 587 with STARTTLS, or port 465 with implicit TLS. | None | No |

Envelopen opens one SMTP connection for each batch. It sends each message in its own transaction, with both unsubscribe headers (`List-Unsubscribe` and `List-Unsubscribe-Post`).

Envelopen sends the password only on an encrypted connection: implicit TLS, or a completed STARTTLS. If the server does not offer STARTTLS on port 587, the connection fails before the password goes out. Cloudflare validates the TLS certificate of the server.

### The Gmail and Google Workspace policy warning

Personal Gmail accounts and Google Workspace accounts are not for bulk email. The Gmail and Google Workspace presets show a policy warning. It has these effects:

- Test sends and owner alerts send through the connection at once.
- The send checklist blocks the first campaign until the owner accepts the warning. Welcome series also need the accepted warning.
- Only the owner can accept the warning, in the Envelopen app. The audit log records who accepted it and when.

## Cost and free tier

- Gmail: free with a Google account.
- Google Workspace: included in the Workspace subscription of the user.
- Custom SMTP: the price of your SMTP service.
- Envelopen adds no cost. SMTP uses Cloudflare TCP sockets, which work on Workers Free.

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Gmail daily limit | 500 recipients per day for a personal account (Google, checked 2026-10-22). | The Gmail preset sets a daily limit of 500. You can change it. |
| Google Workspace daily limit | 2,000 messages per day per user (Google, checked 2026-10-22). | The Workspace preset sets a daily limit of 2,000. You can change it. |
| Daily limit enforcement | The limit is stored with the connection. | Envelopen v0.5 stores the limit. A later update spreads campaigns over several days to stay under it. |
| Google app passwords | Google requires an app password for SMTP. The account needs 2-Step Verification. | Paste the app password, not your normal password. Envelopen removes the spaces that Google shows. |
| Messages per batch | 20 on Workers Free, 50 on Workers Paid. | Set the Workers plan in **Settings**. A smaller batch keeps each send inside the CPU limit of Workers Free. |
| Idempotency | SMTP has no idempotency key. | If a batch times out, the batch becomes uncertain. Open the campaign page and select retry or skip for each uncertain batch. |
| Bounce feedback | Gmail, Workspace, and custom SMTP servers send no webhook. | Bounces arrive as emails in the inbox of the sender. Envelopen does not suppress these addresses. Suppress them by hand. |
| Port 25 | Not supported. | Use port 587 with STARTTLS or port 465 with implicit TLS. |
| From address | Gmail rewrites a From address that the account does not own. | Send from the Google address, or from an alias that you added in Gmail. |
| Quota replies | A 4xx or 5xx reply with quota words, such as "daily sending limit exceeded". | Envelopen pauses the campaign. Resume it after the limit resets. |

## When to choose it, and when not to

Choose SMTP when:

- You have a small list, and you already have a Gmail or Workspace account.
- Your organization has an SMTP relay for newsletters.
- You use Brevo. See [Brevo](provider-brevo.md).

Do not choose Gmail or Google Workspace when:

- Your list has more than a few hundred contacts.
- You need bounce and complaint events in Envelopen. Use Amazon SES, Resend, Postmark, or Brevo.
- Your contacts did not ask for your email. Google can lock the account.

## Setup

### Gmail and Google Workspace

1. Sign in to your Google account.
2. Turn on 2-Step Verification.
3. Open https://myaccount.google.com/apppasswords.
4. Create an app password with the name "Envelopen".
5. Copy the 16-character app password.

If you use Google Workspace and the app password page is missing, ask your Workspace admin. The admin can turn app passwords off for the organization.

### Custom SMTP

1. Get the SMTP host, the port, the TLS mode, the user name, and the password from your SMTP service.
2. Make sure that the server offers STARTTLS on port 587, or implicit TLS on port 465.

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **SMTP** and select **Connect**.
3. Under **Service**, select **Gmail**, **Google Workspace**, **Brevo**, or **Custom SMTP**.
4. For Gmail or Google Workspace, enter the Google address and the **App password**.
5. For Custom SMTP, enter the **SMTP host**, the **Port**, the **TLS mode**, the **User name**, and the **Password**.
6. Check the **Daily sending limit**. Change it if your account has another limit.
7. Select **Connect**. Envelopen signs in to the server and sends QUIT. It sends no email.
8. Open the **Sending domains** tab. Add the domain of your From address.
9. Under **Send a test**, send a test to yourself.

### Accept the policy warning (Gmail and Google Workspace)

1. On the connection card, find the note "Campaigns are blocked on this connection".
2. Select **Review the warning**.
3. Read the warning in the dialog "Send campaigns through Gmail?".
4. Select the checkbox "I understand the risk, and I take responsibility for campaigns sent through Gmail."
5. Select **Accept the warning**.

The card then shows "You accepted the sending policy warning" with the date.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "SMTP 535 ... Google needs an app password" | You entered the normal Google password, or the app password is wrong. | Create a new app password and connect again. |
| "The SMTP server does not offer STARTTLS" | The server does not encrypt port 587. | Use port 465 with implicit TLS, or ask the provider for STARTTLS. |
| "Port 25 is not supported" | Port 25 is for server-to-server mail. | Use port 587 or 465. |
| "The SMTP server did not answer in time" | The host or the port is wrong, or a firewall blocks Cloudflare. | Check the host and the port. Select **Check** on the card. |
| The campaign pauses with a quota message | The account reached its daily limit. | Wait for the limit to reset, then resume the campaign. Lower the **Daily sending limit**. |
| Bounces do not show in Envelopen | The server sends no events. | This is expected. Suppress bounced addresses by hand, or use Brevo. |
| The send checklist fails on **Provider policy** | The owner did not accept the Gmail warning. | Select **Open connections**, then **Review the warning**. |

## Sources

Last checked: 2026-10-22

- [Gmail sending limits](https://support.google.com/mail/answer/22839)
- [Google Workspace sending limits](https://support.google.com/a/answer/166852)
- [Sign in with app passwords](https://support.google.com/accounts/answer/185833)
- [Google email sender guidelines](https://support.google.com/a/answer/81126)
- [RFC 6409: Message Submission for Mail](https://www.rfc-editor.org/rfc/rfc6409)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
