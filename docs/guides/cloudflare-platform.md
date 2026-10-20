# Cloudflare Workers platform

Last checked: 2026-10-19

This guide covers the Cloudflare products that one Envelopen deployment uses, their Free and Paid limits, and what Envelopen does at each limit. The database has its own guide: [Cloudflare D1](database-d1.md).

## What Envelopen uses it for

Envelopen is one Worker. `wrangler.jsonc` at the repository root declares every binding.

| Product | Binding | Use in Envelopen |
|---|---|---|
| Workers | (the Worker) | The admin app (static assets), the REST API (`/api/*`), the MCP server (`/mcp`), tracking links (`/t/*`), the unsubscribe and preference pages (`/u/*`), provider webhooks (`/hooks/*`), and a cron trigger that runs every minute. |
| D1 | `DB` | All Envelopen data. See [Cloudflare D1](database-d1.md). |
| Queues | `SEND_QUEUE` | One message for each send batch. The consumer takes one message per invocation (`max_batch_size: 1`). Failed messages go to `send-queue-dlq` after 10 tries. |
| Workflows | `IMPORT_WORKFLOW`, `CAMPAIGN_WORKFLOW` | CSV imports in chunks of 100 rows. Campaign recipient snapshots in pages. |
| Durable Objects (SQLite) | `AUTH_RATE_LIMITER`, `USAGE_METER`, `RATE_LIMITER`, `EVENT_BUFFER` | Login attempt counters. The daily D1 write counter and the `platform_limit` flag. A token bucket for each provider connection. A buffer for tracking and provider events in each workspace. |
| KV | `KV` | Declared for read-mostly cache data. Envelopen v1 does not read or write it yet. |
| R2 | `BUCKET` | Uploaded CSV files, import error files, and contact exports. Each file is deleted after 24 hours. |

## Cost and free tier

| Plan | Price | Summary |
|---|---|---|
| Workers Free | 0 USD | Every product above is available. Most limits are daily and reset at 00:00 UTC. |
| Workers Paid | 5 USD per month minimum | No daily request limit. No daily D1 limit. Higher limits for each invocation. Usage above the included amounts is billed. |

Envelopen cannot read the plan of your account. The first-run screen and the **Usage** page show the Free and Paid values next to each other.

## Limits and constraints

All values come from the Cloudflare pages in [Sources](#sources). The Free daily limits reset at 00:00 UTC.

### D1 rows written per day

| Free | Paid |
|---|---|
| 100,000 per day | 50 million per month included, then 1.00 USD per million. No daily limit. |

This is the limit that a Free deployment reaches first. A sent email costs about 3 rows written. Imports, tracking events, and unsubscribes also write rows.

What happens on Free:

1. A database proxy counts the rows that each invocation writes. It reports the total to the `UsageMeter` Durable Object.
2. The **Usage** page and the sidebar usage card show the rows used today. From 80% (80,000 rows), they show a warning and advise Workers Paid.
3. At the limit, D1 rejects every query until 00:00 UTC. The first rejected query sets the `platform_limit` flag in the `UsageMeter`. The flag is in Durable Object storage, because D1 cannot accept the write.
4. While the flag is set, the send consumer drops each queue message without a write. Sending pauses. The campaign page shows the pause and the reset time.
5. The cron trigger runs every minute. After 00:00 UTC, it resumes the paused campaigns, sends the waiting batches to the queue again, and clears the flag.
6. A running CSV import waits until 00:05 UTC, then continues with the same chunk. A campaign snapshot waits until after 00:00 UTC, then takes the same page again.
7. Opens, clicks, and provider events stay in the `EventBuffer` Durable Object. The buffer writes them to D1 after the reset.

Writes that cannot wait fail until the reset. On Free, a one-click unsubscribe after the limit returns an error page (HTTP 503), and the preference page cannot save. The admin app and the API also return errors, because D1 rejects reads too. Gmail and Yahoo expect an unsubscribe to take effect within 2 days, so an unsubscribe that fails at night must succeed when the recipient tries again. Use Workers Paid when you send regular campaigns.

### D1 rows read per day

| Free | Paid |
|---|---|
| 5 million per day | 25 billion per month included, then 0.001 USD per million. No daily limit. |

Envelopen does not measure rows read in v1. The Usage page lists the limit as "Not measured". At the limit, D1 rejects queries in the same way as for rows written. Large contact lists, list filters, and campaign snapshots read the most rows. Dashboards read rollup tables, not raw events.

### Workers requests per day

| Free | Paid |
|---|---|
| 100,000 per day | No limit |

Every request that runs the Worker counts: API calls from the admin app, tracking pixels, click redirects, unsubscribe pages, provider webhooks, and MCP calls. Static assets of the admin app do not run the Worker, and Cloudflare serves them free. Workflow requests share this limit. Cloudflare does not say if cron and queue consumer invocations count on Free. The cron runs 1,440 times a day.

At the limit, Cloudflare returns error 1027 until 00:00 UTC. Envelopen cannot run, so tracked links stop redirecting, unsubscribe pages do not open, and webhooks fail. Most providers retry a webhook. toSend does not. Envelopen does not measure this limit. A large campaign with open and click tracking can use more than one request for each recipient on the first day. Turn off click tracking for a large campaign on Free, or use Workers Paid.

### CPU time per invocation

| Free | Paid |
|---|---|
| 10 ms | 30 s by default, up to 5 min |

Envelopen keeps each unit of work small for the Free limit:

- The send consumer handles one batch per invocation. The default batch is 50 recipients (Resend, Postmark, toSend) or 25 recipients (Amazon SES, Cloudflare Email).
- Personalization needs one HMAC for each recipient. Templates render in the browser at save time, not in the Worker.
- A CSV import step reads 100 rows or 64 KB, whichever comes first.
- Password hashes use PBKDF2. The `PBKDF2_ITERATIONS` variable sets the cost. Below 100,000, the owner signs in with a passkey. The [release checklist](release-checklist.md) has the benchmark.

An invocation that runs over the limit fails. The queue then retries the batch.

### Subrequests per invocation

| Free | Paid |
|---|---|
| 50 (and 1,000 to internal Cloudflare services) | 10,000 by default |

A subrequest is a `fetch` call or a call to a Cloudflare service such as D1, KV, or R2. Each send batch makes one provider call for Resend, Postmark, and toSend. Amazon SES and Cloudflare Email need one call for each recipient, so their batch is 25. The Cloudflare page does not say if D1 calls count toward 50 or toward 1,000. The [release checklist](release-checklist.md) has a check for this.

### Queues

| Limit | Free | Paid |
|---|---|---|
| Operations | 10,000 per day | 1,000,000 per month included, then 0.40 USD per million |
| Message retention | 24 hours, fixed | 4 days by default, up to 14 days |
| Consumer duration | 15 min | 15 min |

A message uses about 3 operations (write, read, delete). Each retry adds a read. A message that moves to the dead-letter queue adds a write. A message holds one batch pointer, so 10,000 operations carry about 3,000 batches (about 75,000 to 150,000 recipients). The consumer uses `max_batch_size: 1`, `max_retries: 10`, and the dead-letter queue `send-queue-dlq`. The cron sweep sends a dead-lettered batch to the queue again.

On Free, a message expires after 24 hours. Envelopen keeps all recipient state in D1, and the sweep sends waiting batches to the queue again. So an expired message delays a batch but does not lose it.

### Workflows

| Limit | Free | Paid |
|---|---|---|
| Concurrent instances per account | 100 | 50,000 |
| Steps per Workflow | 1,024 | 10,000 by default, up to 25,000 |
| CPU time per step | 10 ms | 30 s by default, up to 5 min |
| State retention of completed instances | 3 days | 30 days |
| Instance creation rate | 100 per second | 300 per second per account |

One import run has at most 1,000 chunks of 100 rows. So one CSV file can import at most 100,000 rows. Only one import runs at a time in a workspace. One campaign snapshot has at most 1,000 pages. Envelopen keeps its own history in D1, so the short state retention on Free has no effect.

### Durable Objects

On Free, only SQLite-backed Durable Objects are available. Every Envelopen class uses the SQLite backend (`new_sqlite_classes` in `wrangler.jsonc`).

| Limit | Free | Paid |
|---|---|---|
| Requests | 100,000 per day | 1 million per month included, then 0.15 USD per million |
| Duration | 13,000 GB-s per day | 400,000 GB-s per month included |
| Rows read (SQLite) | 5 million per day | 25 billion per month included |
| Rows written (SQLite) | 100,000 per day | 50 million per month included |
| Stored data | 5 GB per account | 5 GB-month included |

At a Free limit, operations of that type fail with an error until 00:00 UTC. Each tracking hit and each webhook is one request to the `EventBuffer`, and the buffer stores each event as a row before it writes the event to D1. Each send batch calls the `RateLimiter` and reads the `UsageMeter`. Each invocation that writes to D1 reports to the `UsageMeter`. If the `EventBuffer` reaches a limit, Envelopen loses tracking events that arrive after the limit.

### KV

| Limit | Free | Paid |
|---|---|---|
| Reads | 100,000 per day | Unlimited |
| Writes, deletes, lists | 1,000 per day each | Unlimited |
| Stored data | 1 GB | Unlimited |

Envelopen v1 does not use KV yet, so these limits have no effect.

### R2

| Limit | Free tier (each month) |
|---|---|
| Storage | 10 GB-month |
| Class A operations (writes) | 1 million |
| Class B operations (reads) | 10 million |
| Egress | Free |

Envelopen stores only short-lived files: CSV uploads, import error files, and contact exports. The CSV upload limit is 5 MB. The cron deletes each file after 24 hours. A normal deployment stays inside the free tier.

## When to choose it

Cloudflare is the only platform for Envelopen v1. The choice is between Free and Paid.

- **Workers Free:** Use it to try Envelopen, for small lists, and for occasional campaigns. Expect a stop at about 25,000 to 30,000 recipients per day. Expect failed unsubscribes and a stopped admin app after the D1 limit, until 00:00 UTC.
- **Workers Paid:** Use it for regular campaigns. It removes the daily D1 limit and the daily request limit, so sending, tracking, and unsubscribes do not stop.

## Setup

1. Create a Cloudflare account at https://dash.cloudflare.com.
2. Optional: add the domain for your tracking links as a zone in the same account. See [Set up a sending domain](sending-domain.md).
3. Recommended: upgrade to Workers Paid. In the dashboard, open **Workers & Pages**, then **Plans**.

## Connect to Envelopen

1. Select the **Deploy to Cloudflare** button in the [README](../../README.md).
2. Enter the secrets that the deploy page asks for. The README explains each secret.
3. Wait for the build and the deploy. The deploy script applies the D1 migrations.
4. Open the Worker URL, and complete the first-run setup.
5. Read the **Workers plan limits** table on the first-run screen. The **Usage** page shows the same table later.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A campaign shows a pause until 00:00 UTC. | D1 rejected writes after the daily limit. | Wait for the reset. The cron resumes the campaign. To prevent it, upgrade to Workers Paid. |
| The admin app shows errors, and unsubscribe pages fail. | D1 daily limit on Free. | Wait for 00:00 UTC, or upgrade to Workers Paid. Upgrades take effect within minutes. |
| Error 1027 on every page. | The Workers Free request limit. | Wait for 00:00 UTC, or upgrade to Workers Paid. |
| The log shows "Exceeded CPU time limit" in the send consumer. | A batch is too large for 10 ms CPU. | Report it with the provider and the batch size. The [release checklist](release-checklist.md) has the CPU check. |
| A batch stays in the dead-letter queue. | The provider refused it 10 times. | Check the provider status on the **Connections** page. The cron sweep sends the batch again. |
| The first-run screen shows a failed binding. | The deploy did not create a resource. | Keep the binding in `wrangler.jsonc`, and deploy again. |

## Sources

Last checked: 2026-10-19

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Gmail email sender guidelines](https://support.google.com/a/answer/81126) (unsubscribe within 2 days)
