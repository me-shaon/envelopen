# Changelog

All changes to Envelopen that affect a deployment are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

Each release can have these subsections:

- **Added**, **Changed**, **Fixed**, **Removed**, and **Security**: the usual Keep a Changelog groups.
- **Manual steps**: work that the owner must do for this release, for example a new secret or a new repository variable. The update workflow cannot do these steps.
- **Breaking**: changes that need a decision or a change from the owner before the update, for example a removed setting or a changed API.

The release workflow uses the section of a version as the notes of its GitHub release. The update workflow shows these notes in its pull request and in its job summary.

## [Unreleased]

### Added

- Single-choice and multiple-choice custom fields with options that you can add, rename, reorder, and merge.
- Signup forms as a hosted page and an iframe embed, with Turnstile and a confirmation email before each subscription.

### Manual steps

- To use signup forms, create a Turnstile widget for the hostname of your deployment in the Cloudflare dashboard. Then set the Worker secrets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`.

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

[Unreleased]: https://github.com/me-shaon/envelopen/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/me-shaon/envelopen/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/me-shaon/envelopen/releases/tag/v0.1.0
