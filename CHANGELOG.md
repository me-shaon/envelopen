# Changelog

All changes to Envelopen that affect a deployment are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

Each release can have these subsections:

- **Added**, **Changed**, **Fixed**, **Removed**, and **Security**: the usual Keep a Changelog groups.
- **Manual steps**: work that the owner must do for this release, for example a new secret or a new repository variable. The update workflow cannot do these steps.
- **Breaking**: changes that need a decision or a change from the owner before the update, for example a removed setting or a changed API.

The release workflow uses the section of a version as the notes of its GitHub release. The update workflow shows these notes in its pull request and in its job summary.

## [Unreleased]

### Changed

- Faster contact pages, list and tag counts, and audit log on large workspaces.
- Deleting a contact or a draft campaign no longer reads every event and recipient.
- The hourly event retention job reads only the expired events.
- Event flushes look up campaign recipients by id instead of reading the workspace.

### Fixed

- A contact page of 100, and adding 100 contacts to a list, stay within the D1 limit of 100 bound parameters.

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
