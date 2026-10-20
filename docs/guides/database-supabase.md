# Supabase

Last checked: 2026-10-19

## What Envelopen uses it for

Envelopen uses Supabase only as a Postgres database. It does not use Supabase Auth, Storage, Edge Functions, or the REST API.

The Worker connects to Supabase through Cloudflare Hyperdrive. Hyperdrive keeps a pool of database connections near the Worker, so each request does not open a new connection.

## Cost and free tier

| | Free | Pro |
|---|---|---|
| Price | 0 USD | From 25 USD per month |
| Database size | 500 MB per project | 8 GB per project included, then 0.125 USD per GB |
| Egress | 5 GB | Higher (see pricing page) |
| Active projects | 2 | No fixed limit |
| Automatic backups | No | Yes |
| Pausing | After 1 week of inactivity | Never |

Hyperdrive (Cloudflare) also has a cost:

| | Workers Free | Workers Paid |
|---|---|---|
| Hyperdrive queries | 100,000 per day | No limit |

## Limits and constraints

| Limit | Effect on Envelopen |
|---|---|
| Free project pauses after 1 week of inactivity | If no one opens Envelopen and no email events arrive for a week, the database pauses. Scheduled campaigns then fail. Use Pro for production, or make sure the project stays active. |
| 500 MB database on Free | About the same capacity as D1 Free. |
| No backups on Free | You can lose data. Use Pro, or export regularly. |
| Hyperdrive: 100,000 queries per day on Workers Free | The daily ceiling is similar to D1 Free (about 25,000 to 30,000 recipients per day). |
| Egress: 5 GB on Free | Large exports and reports use egress. Normal use stays well below this. |
| Hyperdrive: about 20 database connections per configuration on Workers Free (about 100 on Paid) | Enough for Envelopen. Supabase Free allows more direct connections than this. **[verify Supabase Free connection limit]** |
| Hyperdrive: 60 s maximum query duration | Long reports use rollup tables. |

## When to choose it, and when not to

Choose Supabase when:

- You already use Supabase.
- You want to query Envelopen data from other tools with SQL.
- You want the Supabase dashboard to browse and edit data.

Do not choose Supabase Free when:

- You run production campaigns. The pause and the lack of backups are a risk. Use Supabase Pro or D1.

## Setup

1. Create a project at https://supabase.com/dashboard.
2. Select a region near most of your users.
3. Save the database password.
4. In the SQL Editor, create a dedicated role for Envelopen. Do not use the `postgres` superuser in production.
5. On the database settings page, copy the **Direct connection** string. Do not use a pooled connection string, because Hyperdrive does its own pooling.

## Connect to Envelopen

1. Create the default Hyperdrive configuration with the cache disabled:
   `npx wrangler hyperdrive create envelopen-db --connection-string="postgres://USER:PASSWORD@HOST:5432/postgres" --caching-disabled`
2. Copy the Hyperdrive `id` into `wrangler.jsonc` and bind it as `HYPERDRIVE`.
3. Optional: create a second configuration without `--caching-disabled` and bind it as `HYPERDRIVE_CACHED`. Envelopen uses it only for reads that can be up to 1 minute old (public archive, RSS, dashboard stats).
4. Make sure `compatibility_flags` in `wrangler.jsonc` includes `nodejs_compat`.
5. Set `DB_DRIVER` to `postgres`.
6. Run the migrations: `npm run db:migrate:postgres`. (Command name is a placeholder.)

### Why the default binding has no cache

Hyperdrive caches read queries for 60 seconds by default. It does not clear the cache when Envelopen writes. With the cache on, a paused campaign can continue to send, or a suppressed contact can receive one more email. So the default binding must use `--caching-disabled`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Connection errors after some days without use | The free project is paused. | Restore the project in the Supabase dashboard. |
| "Hyperdrive daily limit exceeded" | 100,000 queries per day on Workers Free. | Wait for 00:00 UTC, or upgrade to Workers Paid. |
| Too many connections | Direct connection string used without Hyperdrive. | Use Hyperdrive. As a fallback without Hyperdrive, use the transaction pooler (port 6543). |
| Data in the UI is up to 1 minute old | The default binding has the cache on. | Recreate it with `--caching-disabled`. |
| Driver errors such as "net module not found" | `nodejs_compat` flag missing. | Add it to `compatibility_flags`. |

## Sources

- [Supabase pricing](https://supabase.com/pricing)
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)
- [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Connect Hyperdrive to Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
