# Welcome series

This guide explains how to send a welcome series: 1 to 5 emails that each new subscriber of a list gets, one at a time, with a wait before each email.

## Before you start

- Connect an email provider that can send campaigns, and verify a sending domain. A welcome email is marketing email, so it uses the same provider policy as a campaign. If the provider is transactional-only, accept its warning first. See the [provider guides](README.md#email-providers).
- Create the list. Each list can have one series.
- Create the templates of the emails in **Templates**. The editor can also make a starter welcome email for email 1.
- Optional: create a signup form for the list. See [Signup forms](signup-forms.md).
- On the Workers Free plan, read [The reserved D1 budget](#the-reserved-d1-budget).

## Steps

### Create a series

1. Open **Welcome series**, and select **New series**. You can also open **Contacts** > **Lists**, and select **Add** in the **Welcome series** column of the list.
2. Under **List and sender**, type a **Name**, and select the **List**.
3. Optional: type a **From name**, a **From address**, and a **Reply-to address**. If **From address** is empty, Envelopen sends from `noreply@` on the first verified sending domain.
4. Under **Emails**, set the wait before email 1 in **Wait after the contact joins**. Select **minutes**, **hours**, or **days**.
5. Type the **Subject**, and select the **Template**.
6. To add the next email, select **Add email**. Set the wait in **Then wait**. The wait starts after the email before it.
7. Select **Create series**.
8. Turn on the switch **Series is off**. The switch then shows **Series is on**.

A new series is off. Save your changes before you turn the series on or off. You cannot turn on a series with no email.

The limits:

| Item | Limit |
|---|---|
| Emails in a series | 1 to 5 |
| Wait before an email | From 0 minutes to 30 days |
| Series for each list | 1 |

If you have no templates, select **Use the starter email**. Envelopen creates a short welcome template for email 1. Edit it later in **Templates**.

The emails use the same merge tags as campaigns, including custom fields. Each email has both unsubscribe headers and an unsubscribe link.

### Check the emails

1. Select **Preview** on an email. The preview uses sample values.
2. Select **Send test** on an email. Envelopen sends the template with the subject of that email and the sample values to your test addresses.

See [Send a test email](test-send.md) for test addresses and the header check.

### What starts the series

A contact starts the series when the contact joins the list in one of these ways:

- The contact confirms a signup through a form that adds the list.
- An API key or an MCP client adds the contact with `startWelcome: true`. This works with `POST /api/contacts` (with `listIds`) and with `POST /api/lists/{id}/contacts`.

The series must be on, the contact must be subscribed to the list, and the address must not be suppressed.

### What does not start the series

- A CSV import into the list.
- An add in the admin app.
- An API or MCP add without `startWelcome: true`.
- Turning the series on. Contacts who were on the list before do not get the series.
- A resubscribe on the preference page.
- A contact who has a send record in the series already. Each contact gets each series one time only.

A contact on two lists that each have a series gets both series. The editor warns you when the lists of two series share contacts.

### What stops the series for a contact

Before each email, Envelopen reads the contact again. The series stops for the contact when one of these is true:

- The contact unsubscribed from all email, or left the list.
- An unsubscribe of the contact waits in the ledger at the D1 daily limit.
- The address is suppressed, for example after a hard bounce or a complaint.
- You erased the contact.
- You turned the series off, or deleted it.

When you turn a series off, no new contact starts it. Contacts in the series stop at their next email. When you delete a series, Envelopen also deletes its send history.

### Change a series

A change applies to the emails that a contact has not received yet. A contact who waits for email 2 gets the new subject, template, and wait of email 2. An email that a contact received does not go out again.

### Sends and retries

Each contact gets each email once. If the provider accepted an email and the step runs again, Envelopen does not send it again.

If the provider refuses an email for a reason that can pass later, for example a rate limit, Envelopen tries again 4 times: after about 1, 2, 4, and 8 minutes. After the last try, the email is recorded as failed, and the series goes on with the next email. If the provider rejects the message as not valid, Envelopen does not try again.

The **Welcome series** page shows the **Contacts** that entered each series and the emails **Sent**.

### No open or click tracking

Welcome emails have no open pixel and no tracked links. The campaign stats do not include welcome emails. Unsubscribes from a welcome email show on the contact.

### The reserved D1 budget

Workers Free allows 100,000 D1 rows written each day. On Free, welcome emails can use 70% of them (70,000 rows). After that, each welcome email that is due waits until just after 00:00 UTC. Campaigns, confirmation emails, and unsubscribes keep the other 30%.

The Worker cannot read the plan of your Cloudflare account. Tell Envelopen the plan:

1. Open **Settings**.
2. In **Workers plan**, select **Workers Free** or **Workers Paid**.
3. Select **Save plan**.

The setting applies to every workspace. On **Workers Paid**, D1 has no daily write limit, and welcome emails do not wait. Do not select **Workers Paid** on a Free account. Welcome emails can then use the whole daily budget, and campaigns pause at the limit until 00:00 UTC.

The usage view shows the threshold and the D1 writes of welcome emails today. See [Cloudflare Workers platform](cloudflare-platform.md#d1-rows-written-per-day).

### After a restore

A backup holds the series, their send records, and the **Workers plan** setting. It does not hold the running series of each contact. After a restore into a new deployment:

- Contacts who were in a series do not get the rest of it.
- A contact with a send record does not start the series again.
- New subscribers start the series as usual, if the series is on.

Before new signups come in, check the **Workers plan** setting and the switch of each series. See [Back up and restore](backup-and-restore.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Add at least one step before you turn it on." | The series has no email. | Add an email, save, and turn the series on. |
| "Connect an email provider before you send a campaign." | The workspace has no connection. | Connect a provider in **Connections**. |
| "... is a transactional-only provider. Accept its warning before you send a campaign through it." | The provider policy blocks marketing email. | Accept the warning in **Connections**, or connect a campaign provider. |
| "This list has a welcome series already." | Each list has one series. | Open the existing series of the list. |
| A new contact did not get the series. | The contact was imported or added without `startWelcome: true`, or the series was off. | Add the contact through a form, or through the API with `startWelcome: true`. |
| A contact did not get a later email. | The contact unsubscribed, left the list, or was suppressed, or the series is off. | Open the contact, and check the status and the lists. |
| Welcome emails wait until 00:00 UTC. | On Workers Free, the day's D1 writes passed 70%. | Wait for the reset. If your account is on Workers Paid, set **Workers plan** to **Workers Paid**. |
| An email shows as failed. | The provider refused it 5 times. | Check the connection and the provider dashboard. The next email of the series still goes out. |
| A contact got two welcome emails at the same time. | The contact is on two lists with a series each. | Read the overlap warning in the editor, and change the lists or the waits. |

## Related guides

- [Signup forms](signup-forms.md)
- [Send a test email](test-send.md)
- [Cloudflare Workers platform](cloudflare-platform.md)
- [Back up and restore](backup-and-restore.md)

## Sources

- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)

Last checked: 2026-10-21
