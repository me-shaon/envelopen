# Changelog

All changes to Envelopen that affect a deployment are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

Each release can have these subsections:

- **Added**, **Changed**, **Fixed**, **Removed**, and **Security**: the usual Keep a Changelog groups.
- **Manual steps**: work that the owner must do for this release, for example a new secret or a new repository variable. The update workflow cannot do these steps.
- **Breaking**: changes that need a decision or a change from the owner before the update, for example a removed setting or a changed API.

The release workflow uses the section of a version as the notes of its GitHub release. The update workflow shows these notes in its pull request and in its job summary.

## [Unreleased]

### Added

- License: GNU Affero General Public License v3.0.
- A source code link with the version in the admin footer and on each subscriber page. The owner can change it in Settings.

### Changed

- Faster contact pages, list and tag counts, and audit log on large workspaces.
- Deleting a contact or a draft campaign no longer reads every event and recipient.
- The hourly event retention job reads only the expired events.
- Event flushes look up campaign recipients by id instead of reading the workspace.
- Lists and tags store their member counts, so the lists and tags pages no longer count every membership.
- Campaign estimates and recipient snapshots read the memberships of the targeted lists and tags only.
- The end of a recipient snapshot sums the batch sizes instead of counting every recipient.
- Erasing a contact deletes its raw events through the contact index instead of reading every event.
- The onboarding checklist finds a sent email without reading every campaign recipient.
- A daily cron job recounts the stored list and tag counts and corrects any drift.

### Fixed

- A contact page of 100, and adding 100 contacts to a list, stay within the D1 limit of 100 bound parameters.

### Security

- An import raises a consent basis of `unknown` only when the owner configured and started it. An API key cannot configure or start another principal's import with a stronger basis.
- A contact deleted with a consent basis of `unknown` keeps that basis when an API key adds the address again.
- An `Idempotency-Key` used on another resource of the same route gets 422 instead of the first response.
- Failed logins from other IPs no longer lock the owner out. The right password always signs in, and a high per-email ceiling slows guessing from many IPs.
- Adding a passkey from a signed-in session needs a session from the last 10 minutes. A password reset with the setup token removes every passkey.
- The HTML sanitizer checks every copy of a repeated attribute, drops unterminated `url(` and quoted `data:` CSS, and drops a `<style>` with a `<` in it.
- Link tracking no longer slows down on HTML with many unclosed `<a ` tags.
- The admin app sends a Content-Security-Policy, `X-Content-Type-Options`, and `Referrer-Policy`. API responses send `Cache-Control: no-store`.
- Webhook, unsubscribe, setup, and login routes cap the request body while they read it, also without `Content-Length`.
- The CI workflow pins every action to a commit SHA and has read-only permissions.
- Provider credentials and webhook secrets are bound to their connection. The cron encrypts existing values again in the new format.
- New SES webhook URLs carry the token in the path, not the query string. Existing `?token=` URLs keep working.
- `pnpm demo` keeps its secrets in files that only the owner can read, and no longer passes them on the command line.

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

[Unreleased]: https://github.com/me-shaon/envelopen/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/me-shaon/envelopen/releases/tag/v0.1.0
