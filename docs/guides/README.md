# Guides

These guides explain how to set up and run Envelopen, and the external services that it uses. Read the limits of a service before you select it. The limits set how many emails and contacts your deployment can handle.

Vendors change their limits and prices often. Each guide shows the date of the last check. Before you depend on a number, check the official source in the guide.

## Get started

| Guide | What it covers |
|---|---|
| [README](../../README.md) | Deploy, secrets, first-run setup, and the first campaign. |
| [Run Envelopen locally](local-development.md) | Local secrets, the local database, the cron, and the provider mock. |
| [Set up a sending domain](sending-domain.md) | DNS records, verification, and the tracking domain. |
| [Import contacts](import-contacts.md) | CSV files, column mapping, consent basis, tags, lists, and export. |
| [Send a test email](test-send.md) | Test addresses, test sends, and the unsubscribe headers in Gmail. |
| [Connect an MCP client](mcp.md) | API keys, scope presets, and the confirm flow for agents. |
| [Update Envelopen](updating.md) | The update workflow, update modes, manual updates, backups, and rollback. |

## Platform

| Guide | Status | Last checked |
|---|---|---|
| [Cloudflare Workers platform](cloudflare-platform.md) (Workers, D1, Queues, Workflows, Durable Objects, KV, R2) | Ready | 2026-10-19 |
| [Cloudflare D1](database-d1.md) | Ready | 2026-10-19 |

Envelopen v1 uses D1 only. Postgres (Supabase or other Postgres through Hyperdrive) is planned for v1.x. The [Supabase draft](database-supabase.md) is for that later version, and v1 cannot use it.

## Email providers

| Guide | Policy | Last checked |
|---|---|---|
| [Amazon SES](provider-ses.md) | Campaigns | 2026-10-19 |
| [Resend](provider-resend.md) | Campaigns | 2026-10-19 |
| [Postmark](provider-postmark.md) | Campaigns (Broadcast stream) | 2026-10-19 |
| [toSend](provider-tosend.md) | Transactional only | 2026-10-19 |
| [Cloudflare Email](provider-cloudflare-email.md) | Transactional only | 2026-10-19 |

A transactional-only provider always sends system email, such as test sends. The send checklist blocks a campaign through it until the owner accepts the provider policy warning.

## Contributors and releases

| Guide | What it covers |
|---|---|
| [Write a provider adapter](adapter-authoring.md) | The adapter contract and the conformance kit. |
| [Release checklist](release-checklist.md) | The manual checks on a real deployment before a release, and the release process. |

## Guide template

Every service guide uses these sections, in this order:

1. **What Envelopen uses it for**
2. **Cost and free tier**
3. **Limits and constraints**: each limit, with its effect on Envelopen.
4. **When to choose it, and when not to**
5. **Setup**: numbered steps on the vendor side.
6. **Connect to Envelopen**: numbered steps in Envelopen.
7. **Troubleshooting**: common errors and their fixes.
8. **Sources**: official links, and the date of the last check.

A task guide (for example [Import contacts](import-contacts.md)) uses these sections: **Before you start**, **Steps**, **Troubleshooting**, and **Related guides** or **Sources**.

## Writing rules

Write every guide in ASD-STE100 Simplified Technical English:

- Keep a procedural sentence to 20 words or fewer. Keep a descriptive sentence to 25 words or fewer.
- Write one instruction in each sentence. Use the imperative.
- Use the active voice.
- Put a condition before the instruction that it applies to: "If X, do Y."
- Use the same term for the same thing every time: "owner", "API key", "connection", "sending domain", "campaign".
- Use the names of buttons and fields exactly as the app shows them, in bold.
- Do not leave out articles or verbs to make a sentence shorter.
- Do not use em dashes. Use a period, a colon, or parentheses.
- Do not use filler words such as "robust", "seamless", "comprehensive", or "powerful". Do not use rhetorical questions.
- Give each number with its source, and give the date of the last check.
