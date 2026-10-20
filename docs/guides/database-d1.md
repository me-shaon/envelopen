# Cloudflare D1

Last checked: 2026-10-19

## What Envelopen uses it for

D1 is the only database in Envelopen v1. It stores all Envelopen data: workspaces, contacts, lists, campaigns, events, and stats. D1 is SQLite, managed by Cloudflare. Postgres support (Supabase or other Postgres through Hyperdrive) is planned for v1.x.

## Cost and free tier

| | Free | Paid (Workers Paid, 5 USD per month) |
|---|---|---|
| Rows read | 5 million per day | 25 billion per month included, then 0.001 USD per million |
| Rows written | 100,000 per day | 50 million per month included, then 1.00 USD per million |
| Storage | 5 GB total | 5 GB included, then 0.75 USD per GB-month |

## Limits and constraints

| Limit | Free | Paid | Effect on Envelopen |
|---|---|---|---|
| Rows written per day | 100,000 | No daily limit | The main limit. Each recipient uses about 3 writes. So about 25,000 to 30,000 recipients per day on Free. Imports and events also use writes. Envelopen counts these writes and warns at 80% on the **Usage** page. |
| Rows read per day | 5 million | No daily limit | Queries on large lists read many rows. Envelopen adds indexes to keep this low. Envelopen does not measure rows read. |
| Maximum database size | 500 MB | 10 GB | 500 MB holds about 300,000 to 500,000 contacts, with recent events (estimate). Envelopen deletes raw events after the retention period (90 days by default). |
| Queries per Worker invocation | 50 | 1,000 | Envelopen uses multi-row statements. |
| Bound parameters per query | 100 | 100 | Multi-row inserts are split into chunks. |
| Maximum query duration | 30 s | 30 s | Heavy reports use pre-computed rollup tables. |
| Columns per table | 100 | 100 | Custom contact fields are stored as rows, not columns. |
| Time Travel (point-in-time restore) | 7 days | 30 days | You can restore the database to any minute in this period. |

When a daily limit is reached, D1 rejects every query until 00:00 UTC. A campaign in progress pauses, and Envelopen resumes it after the reset. A running import waits and continues after the reset. On Free, unsubscribes and other writes fail until the reset. [Cloudflare Workers platform](cloudflare-platform.md#d1-rows-written-per-day) explains each step. When storage is full, you must delete data before you can write again.

## When to choose it, and when not to

Envelopen v1 supports only D1. Choose the plan:

- Workers Free: you send fewer than about 25,000 emails per day, and you accept a pause at the daily limit.
- Workers Paid: you send regular campaigns, or you need more than 500 MB.

D1 is not a good fit in these cases. Wait for Postgres support in v1.x:

- Other tools (BI, scripts, your own app) must query the data directly.
- You need more than 10 GB.

## Setup

The **Deploy to Cloudflare** button creates the D1 database. You do not need to do anything.

`wrangler.jsonc` has no `database_id`. Wrangler creates the database on the first deploy. To deploy from your computer instead:

1. Install the dependencies: `corepack pnpm install`.
2. Log in: `npx wrangler login`.
3. Deploy: `corepack pnpm run deploy`. The script applies the migrations, then deploys the Worker.

## Connect to Envelopen

1. Keep the `DB` binding in `wrangler.jsonc`. The migrations are in `packages/db/migrations`.
2. If the first-run screen reports missing tables, run `npx wrangler d1 migrations apply DB --remote` from the repository root.
3. Open the first-run screen again. The **D1 database** and **Database migrations** checks must pass.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Errors that say the daily limits have been exceeded | 100,000 rows written or 5 million rows read today. | Wait for 00:00 UTC, or upgrade to Workers Paid. |
| Writes fail with a storage error | 500 MB database limit reached. | In **Settings**, lower **Keep raw events for (days)**, or upgrade to Workers Paid. |
| The first-run screen reports missing tables | The migrations did not run. | Run `npx wrangler d1 migrations apply DB --remote` from the repository root. |

## Sources

Last checked: 2026-10-19

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
