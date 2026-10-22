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
| Daily limit enforcement | Envelopen counts the emails of the connection in the last 24 hours. | A campaign larger than the limit sends over several days. See [Daily sending limits and multi-day sends](#daily-sending-limits-and-multi-day-sends). |
| Google app passwords | Google requires an app password for SMTP. The account needs 2-Step Verification. | Paste the app password, not your normal password. Envelopen removes the spaces that Google shows. |
| Messages per batch | 20 on Workers Free, 50 on Workers Paid (Envelopen trial 1, local measurement). | Set the Workers plan in **Settings**. A smaller batch keeps each send inside the CPU limit of Workers Free. Release check 22 measures it on a deployed Worker. |
| Idempotency | SMTP has no idempotency key. | If a batch times out, the batch becomes uncertain. Open the campaign page and select retry or skip for each uncertain batch. |
| Bounce feedback | Gmail, Google Workspace, and Custom SMTP have no webhook. Only the Brevo preset has one. | Bounces arrive as emails in the inbox of the sender. Envelopen does not suppress these addresses. Suppress them by hand. |
| Port 25 | Not supported. | Use port 587 with STARTTLS or port 465 with implicit TLS. |
| From address | Gmail rewrites a From address that the account does not own. | Send from the Google address, or from an alias that you added in Gmail. |
| Quota replies | A 4xx or 5xx reply with quota words, such as "daily sending limit exceeded". | Envelopen pauses the campaign. The daily counter of the connection counts as full, so welcome and confirmation emails wait too. Resume the campaign after the limit resets. |

## Daily sending limits and multi-day sends

This section applies to every connection, not only SMTP. The [Brevo](provider-brevo.md) and [Mailgun](provider-mailgun.md) guides link here.

### What the limit counts

The daily sending limit is the most emails that Envelopen sends through one connection in any 24 hours. The 24 hours roll. They do not reset at midnight.

These emails share the limit:

- Campaign emails.
- Welcome emails.
- Form confirmation emails.

Test sends and owner alerts do not use the limit.

A connection without a limit sends at the rate of the provider. Amazon SES, Resend, Postmark, Mailgun, toSend, and Cloudflare Email connections have no limit until you set one. A limit on these connections is optional. For example, set 100 on the Mailgun Free plan.

### Set the limit

The SMTP presets set a default limit when you connect:

| Preset | Default limit | Source |
|---|---|---|
| Gmail | 500 | [Gmail sending limits](https://support.google.com/mail/answer/22839) (checked 2026-10-22) |
| Google Workspace | 2,000 | [Google Workspace sending limits](https://support.google.com/a/answer/166852) (checked 2026-10-22) |
| Brevo | 300 | [Brevo pricing](https://www.brevo.com/pricing/), free plan (checked 2026-10-22) |
| Custom SMTP | None | Your SMTP service |

To change the limit of a connection:

1. Open **Connections**. The **Providers** tab opens.
2. On the connection card, select **Daily limit**.
3. Type a number in **Emails in 24 hours (optional)**. To remove the limit, clear the field.
4. Select **Save limit**.

The card then shows "N of M sent in the last 24 hours". The REST API and MCP have the same operation (`connections.set_daily_cap`).

A new limit applies to the emails after the change. A campaign that sends already keeps its plan, and each later email waits for room under the new limit.

### Multi-day sends

When you send a campaign through a connection with a limit, Envelopen plans the sending days:

- Day 1 starts when the send starts. It gets the limit minus the emails of the last 24 hours.
- Each later day is 24 hours long and gets the full limit.

The confirm dialog shows the plan before you send. The note says "Sends in 1 day", or "Sends over N days, ends about <date>". The note also shows the limit and the emails of the last 24 hours.

During the send, the campaign page shows the banner "Sending day N of M, ends about <date>".

Welcome and confirmation emails use room in the same days. If they use room that the campaign planned for, the rest of the campaign moves to the next day. The end date then moves too.

If the limit is smaller than one batch, Envelopen pauses the campaign. The message says that the daily cap is smaller than one batch. Raise the limit on the connection, then resume the campaign.

### Welcome and confirmation emails at the limit

- A welcome email waits until the connection has room. Then it sends.
- A form confirmation email waits in an outbox. The subscriber sees the same **Check your inbox** page. The cron sends the email with a new link when the connection has room. Envelopen drops no confirmation email.

When confirmation emails wait, the connection card shows the note "Confirmation emails wait" with the count. If your provider allows more email, raise the limit.

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
| The campaign pauses with a quota message | The account reached its daily limit before the Envelopen limit. | Wait for the limit to reset, then resume the campaign. Select **Daily limit** on the card, and lower the limit. |
| The campaign pauses: "The daily cap of N is smaller than one batch" | The limit is smaller than 20 (Workers Free) or 50 (Workers Paid). | Select **Daily limit** on the card, and raise the limit. Then resume the campaign. |
| The card shows "Confirmation emails wait" | The connection reached its limit, and form confirmation emails wait for room. | Wait. Or raise the limit, if your provider allows more. |
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
