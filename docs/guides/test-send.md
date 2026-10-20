# Send a test email

A test email shows how your email looks in a real inbox before you send a campaign. It also lets you check the unsubscribe headers.

## Before you start

- Connect an email provider. See the [provider guides](README.md#email-providers).
- Add a sending domain. See [Set up a sending domain](sending-domain.md). The From address must use a sending domain of the workspace.
- A test email goes only to test addresses. The owner's address is always a test address. You can add more addresses, and a test email goes to at most 5 addresses at a time.

Envelopen sends a test email through the connection that sends all email of the workspace. A transactional-only connection (toSend or Cloudflare Email) can always send a test email.

## Steps

### Send a test from the Connections page

1. Open **Connections**.
2. Scroll to the **Send a test** section.
3. Optional: type an address in **Add an address**, and select **Add**.
4. Select the addresses that get the test.
5. Check the **From address**. Envelopen fills in `hello@` and your sending domain.
6. Select **Send to 1 address** (the count changes with your selection).
7. Read the result. Each address shows **Sent** or **Not sent** with the reason.

This test uses a short built-in message. It completes the "Send a test email" step on the overview.

### Send a test of a template

1. Open **Templates**, and open the template.
2. Select **Send test**.
3. Select the test addresses, and check the **From address**.
4. Select **Send test**.

The subject starts with `[Test]`. Merge tags use sample values, for example "Ada" for `first_name`. The body is the same HTML as the preview.

### Check the unsubscribe headers in Gmail

Gmail and Yahoo require one-click unsubscribe for bulk senders. Envelopen adds two headers to every campaign email and to every test email.

1. Send a test to a Gmail address.
2. Open the email in Gmail on the web.
3. Open the menu (three dots) next to **Reply**, and select **Show original**.
4. Find the `List-Unsubscribe` header. It must hold an `https` URL that ends in `/u/` and a token. In a test email, the URL ends in `/u/test`.
5. Find the `List-Unsubscribe-Post` header. Its value must be `List-Unsubscribe=One-Click`.
6. Check that **SPF**, **DKIM**, and **DMARC** show **PASS** at the top of the page.

The `/u/test` link of a test email changes nothing. A real campaign email carries a signed link for the contact.

If you use Postmark, read the unsubscribe section of the [Postmark guide](provider-postmark.md) first. Postmark replaces these headers until its support team turns on custom unsubscribe handling.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| The From address is rejected. | The domain of the address is not a sending domain of the workspace. | Add the domain on the **Sending domains** page, or use an address on a domain that is there. |
| **Not sent** with a provider error. | The provider rejected the email. The text shows the provider's reason. | Fix the cause at the provider, for example verify the domain there. Then send again. |
| Amazon SES says that the address is not verified. | The SES account is in the sandbox. | Verify the test address in SES, or request production access. See the [SES guide](provider-ses.md). |
| The email is in the spam folder. | DNS records are missing, or the domain is new. | Check that the domain shows **Verified** on the **Sending domains** page. Send a few tests over some days. |
| Gmail shows no `List-Unsubscribe` header. | The provider removed or replaced it. | For Postmark, ask Postmark support for custom unsubscribe handling. For other providers, report it with the "Show original" text. |
| You cannot add an address. | Only the owner's session can change test addresses. An API key cannot. | Sign in as the owner. |

## Related guides

- [Provider guides](README.md#email-providers)
- [Set up a sending domain](sending-domain.md)
- [Release checklist](release-checklist.md)
- [Gmail email sender guidelines](https://support.google.com/a/answer/81126)
- [RFC 8058: one-click unsubscribe](https://www.rfc-editor.org/rfc/rfc8058)

Last checked: 2026-10-20
