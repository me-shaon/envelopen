# Changelog

All changes to Envelopen that affect a deployment are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

Each release can have these subsections:

- **Added**, **Changed**, **Fixed**, **Removed**, and **Security**: the usual Keep a Changelog groups.
- **Manual steps**: work that the owner must do for this release, for example a new secret or a new repository variable. The update workflow cannot do these steps.
- **Breaking**: changes that need a decision or a change from the owner before the update, for example a removed setting or a changed API.

The release workflow uses the section of a version as the notes of its GitHub release. The update workflow shows these notes in its pull request and in its job summary.

## [Unreleased]

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

[Unreleased]: https://github.com/me-shaon/envelopen/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/me-shaon/envelopen/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/me-shaon/envelopen/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/me-shaon/envelopen/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/me-shaon/envelopen/releases/tag/v0.1.0
