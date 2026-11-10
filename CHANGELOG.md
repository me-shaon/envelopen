# Changelog

All changes to Envelopen that affect a deployment are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

Each release can have these subsections:

- **Added**, **Changed**, **Fixed**, **Removed**, and **Security**: the usual Keep a Changelog groups.
- **Manual steps**: work that the owner must do for this release, for example a new secret or a new repository variable. The update workflow cannot do these steps.
- **Breaking**: changes that need a decision or a change from the owner before the update, for example a removed setting or a changed API.

The release workflow uses the section of a version as the notes of its GitHub release. The update workflow shows these notes in its pull request and in its job summary.

## [Unreleased]

### Added

- On the **Contacts** page, you can select contacts, or every contact that matches the filters, and add them to a list or a tag, or remove them from it. A contact who is in the list or has the tag already does not change. See [Change the lists or tags of many contacts](docs/guides/import-contacts.md#change-the-lists-or-tags-of-many-contacts).

### Fixed

- A campaign snapshot that failed got a new Workflow instance every minute until one finished. Now it gets at most one successor at a time, and at most 10 in total.
- An error in the cleanup of expired idempotency keys or expired files no longer stops the other cron jobs, for example the daily backup. These two jobs wait while the D1 daily limit is reached.
- On Workers Free, the send consumer stops taking new campaign batches when the day's D1 writes reach 95% of the limit. The batches wait on the queue until 00:00 UTC. Before, batches that sent at the limit could not record their results, and the campaign asked you to retry or skip them.

## [0.6.0] - 2026-11-04

### Added

- The Worker makes `SIGNING_KEY` and `ENCRYPTION_KEY` on first use when they are not set, and keeps them in R2 under `secrets/`. The Deploy button now asks only for `SETUP_TOKEN`.
- The setup screen tells you how to replace a forgotten setup token.
- Required fields show a red asterisk after the label.
- **Settings** > **Updates** shows the running version and the newest release on GitHub, with a **Check now** button. A daily check asks GitHub for the newest release. The owner can turn it off.

### Changed

- A request of the admin app fails after 30 seconds without an answer, instead of a page that waits forever. A CSV upload gets 2 minutes.
- A saved webhook signing secret shows as a masked value in the connection dialog.
- The version is in `apps/worker/src/version.ts`, not in `package.json`. The Deploy button sets the version in `package.json` to `0.0.0`, so the app footer and the update workflow showed `0.0.0`.
- The update workflow finds the release of a copy without a version from the release tag with the fewest changed lines.
- Updates do not add back the `.github` files that a Deploy button copy left out, and they keep the `name` and `version` lines of `package.json`.

### Security

- `.dev.vars.example` holds no example secret values. The Deploy button filled its secret fields from that file.
- The setup screen stays closed when `SETUP_TOKEN` is the old public example value.

### Manual steps

- The Deploy button does not copy `.github`. If your repository has no **Envelopen updates** workflow, add it by hand. See [Add the update workflow](docs/guides/updating.md#add-the-update-workflow).
- If your `SETUP_TOKEN` is `replace-with-at-least-32-random-characters`, set a new value. See [You forgot the setup token](README.md#you-forgot-the-setup-token).

## [0.5.0] - 2026-10-22

### Added

- An SMTP provider with Gmail, Google Workspace, Brevo, and custom SMTP presets.
- A Mailgun provider for US and EU accounts, with an automatic webhook.
- Brevo webhooks for bounces, complaints, blocked messages, and unsubscribes.
- A daily sending limit for each connection, with a default from the SMTP preset.
- Multi-day sends: a campaign larger than the daily limit sends over several 24-hour days.
- The sending days and the expected end date in the confirm dialog and on the campaign page.
- The use of the daily limit in the last 24 hours on each connection card.
- A policy warning for the Gmail and Google Workspace presets, accepted by the owner.
- SMTP batches of 20 messages on Workers Free and 50 on Workers Paid.
- A local SMTP mock for development and end-to-end tests.
- Guides for SMTP, Brevo, Mailgun, and daily sending limits.

### Changed

- Welcome emails wait for room under the daily limit of the connection.
- Form confirmation emails wait in an outbox at the daily limit, and the cron sends them later.
- A provider quota error fills the daily counter, so other sends of the connection wait too.
- Backups include the daily limit of each connection and the sending days of each campaign.

### Security

- SMTP sends the password only after implicit TLS or a completed STARTTLS.
- The Brevo webhook checks a rotatable bearer token in constant time. The URL holds no secret.
- The Mailgun webhook checks the HMAC signature, a 5-minute timestamp window, and a single-use token.

### Manual steps

- Optional: set a daily sending limit on existing connections, for example 100 on the Mailgun Free plan.
- For Brevo, run the `curl` command in the **Brevo events** dialog once to create the webhook.
- For Gmail and Google Workspace, accept the policy warning before the first campaign.

## [0.4.0] - 2026-10-22

### Added

- A brand kit in **Brand**: name, logo, colors, font, footer, postal address, and social links.
- Brand tokens such as `{{ brand.color_primary }}` for templates, with brand header and brand footer blocks.
- A template gallery with ten starter templates that use the brand kit, with live previews.
- A drag-and-drop block library with ready sections and saved blocks.
- Sections with 1 to 3 columns, and a panel block with a background color.
- Button text on a brand color that is white or dark, with a contrast of 4.5:1 or more.
- Keyboard moves for blocks: Alt+Shift+Up and Alt+Shift+Down.
- A desktop and mobile canvas, and a block library sheet on narrow screens.
- A guide for the brand kit and templates.

### Changed

- Drafts, previews, test sends, and welcome emails use the live brand kit.
- A confirmed campaign keeps a snapshot of the brand kit.
- The send checklist needs a postal address in the brand kit.
- **New template** opens the gallery. The welcome series starter email is the gallery welcome email.
- Backups include the brand kit and the logo files.

### Fixed

- The demo seeds a brand kit with a postal address, so its campaigns can be confirmed.

### Security

- Logos must be PNG, JPEG, GIF, or WebP by their content, up to 1 MB. SVG is refused.
- The logo route sends the stored type with `nosniff` and a sandbox Content-Security-Policy.
- Brand values are checked and escaped before they go into an email.

### Manual steps

- Add a postal address in **Brand** before you confirm a campaign.

## [0.3.0] - 2026-10-21

### Added

- Single-choice and multiple-choice custom fields, with options that you can rename, reorder, and merge.
- Signup forms as a hosted page and an iframe embed, with Turnstile and double opt-in.
- Consent records for form signups: the form, the consent text version, an IP hash, and the user agent.
- Required fields on forms.
- Custom fields on the preference page, hidden, read only, or editable by the subscriber.
- Welcome series: 1 to 5 emails with a wait before each, for new subscribers of a list.
- A Workers plan setting (Free or Paid) in Settings.
- Guides for signup forms and welcome series.

### Changed

- Imports map choice fields by option label, without regard to case. Unknown labels go to the error file.
- Exports and merge tags print the labels of choice fields.
- On Workers Free, welcome emails wait after 70% of the daily D1 writes until 00:00 UTC.
- The usage view shows the welcome threshold and the D1 writes of welcome emails.
- Unsubscribes, suppressions, and erases stop the welcome series of the contact.

### Security

- Every form submission gets the same response, and suppressed addresses get no email.
- Rate limits on form submissions and confirmation emails, for each IP, address, form, and workspace.
- A confirmation link confirms only with a button press, so mail scanners cannot confirm.
- Embed origins must be bare https origins before they enter `frame-ancestors`.
- Turnstile tokens must match the hostname of the form page and the action of the widget.

### Manual steps

- To use signup forms, create a Turnstile widget for the hostname of your deployment in the Cloudflare dashboard. Then set the Worker secrets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`.
- If your account is on Workers Paid, set **Settings** > **Workers plan** to **Workers Paid**.

## [0.2.0] - 2026-10-21

### Added

- Encrypted daily backups to R2, with an optional S3-compatible copy and retention.
- Backup status, downloads, and a failure banner in the admin app.
- Restore of a backup into a new deployment from the first-run screen.
- Timezone for scheduled campaigns.
- Source code link with the version in the admin footer and on subscriber pages.
- License: AGPL-3.0.

### Changed

- Lists and tags store their member counts, and a daily job corrects drift.
- Faster contact pages, audit log, snapshots, estimates, and erase on large workspaces.
- Fewer D1 reads for retention, event flushes, deletes, and the onboarding checklist.

### Fixed

- One-click unsubscribe and preference saves work at the D1 daily limit.
- Contact pages and list adds stay within the D1 limit of 100 bound parameters.

### Security

- Stricter consent basis rules for imports and re-added contacts.
- Owner login cannot be locked out from other IPs.
- Adding a passkey needs a recent sign-in.
- Stricter HTML sanitizer and faster link tracking on malformed HTML.
- Security headers on the admin app and `no-store` on API responses.
- Request body caps on public routes.
- Credentials bound to their connection, and SES webhook tokens moved to the path.
- Idempotency keys refuse reuse on another resource.
- CI actions pinned to commit SHAs, and demo secrets kept off the command line.

## [0.1.0] - 2026-10-20

The first release of Envelopen: self-hosted email campaigns on Cloudflare Workers.

### Added

- One-click Deploy to Cloudflare, first-run setup, and owner login with a password or a passkey.
- Contacts, lists, tags, CSV import, export, and GDPR erase.
- Amazon SES, Resend, and Postmark for campaigns. toSend and Cloudflare Email for system email.
- Sending domains with SPF, DKIM, and DMARC checks.
- Block editor templates and test sends.
- Campaigns with a send checklist, scheduling, and batched sends.
- Open and click tracking, one-click unsubscribe, and campaign stats.
- Audit log, REST API with API keys, and an MCP server.
- Weekly update workflow for Deploy button repositories.
- `pnpm demo` with sample data and no real email.

### Fixed

- No double send when a provider refuses a retried batch.
- Erase also removes the contact from stored batch data.
- Unsubscribe links use the tracking domain only after it is verified.

[Unreleased]: https://github.com/me-shaon/envelopen/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/me-shaon/envelopen/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/me-shaon/envelopen/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/me-shaon/envelopen/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/me-shaon/envelopen/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/me-shaon/envelopen/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/me-shaon/envelopen/releases/tag/v0.1.0
