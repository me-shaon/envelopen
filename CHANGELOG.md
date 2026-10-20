# Changelog

All changes to Envelopen that affect a deployment are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

Each release can have these subsections:

- **Added**, **Changed**, **Fixed**, **Removed**, and **Security**: the usual Keep a Changelog groups.
- **Manual steps**: work that the owner must do for this release, for example a new secret or a new repository variable. The update workflow cannot do these steps.
- **Breaking**: changes that need a decision or a change from the owner before the update, for example a removed setting or a changed API.

The release workflow uses the section of a version as the notes of its GitHub release. The update workflow shows these notes in its pull request and in its job summary.

## [Unreleased]

## [0.1.0] - 2026-10-20

The first release.

### Added

- Deploy to Cloudflare button. It provisions D1, KV, R2, the send queue with a dead-letter queue, two Workflows, and four Durable Objects.
- First-run setup with a setup token, deployment checks, and the plan limits. Owner login with a password or a passkey, and recovery with the setup token.
- Workspaces, contacts, lists, and tags. CSV import with column mapping and consent basis, contact export, and contact erase.
- Email providers: Amazon SES, Resend, and Postmark for campaigns. toSend and Cloudflare Email for system email and test sends. Envelopen creates the bounce and complaint webhooks where the provider allows it.
- Sending domains with SPF, DKIM, and DMARC checks, and an optional tracking domain.
- Templates with an email block editor, Markdown templates, and test sends.
- Campaigns with a send checklist, a recipient estimate, scheduled sends, and batch sends through the queue within the provider rate limit.
- Open and click tracking with machine-open detection, one-click unsubscribe, a suppression list, and campaign stats.
- The audit log for every change, with the actor, the surface, and the target.
- A REST API with an OpenAPI document, API keys with scopes, and an MCP server for AI agents.
- Daily D1 write metering that pauses campaigns at the Workers Free limit and resumes them after the reset.
- The update workflow for repositories made with the Deploy button, and the version in **Settings** and in `GET /api/health`.

[Unreleased]: https://github.com/me-shaon/envelopen/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/me-shaon/envelopen/releases/tag/v0.1.0
