# Run Envelopen locally

This guide shows how to run Envelopen on your computer with `wrangler dev`. The local Worker uses local copies of D1, KV, R2, Queues, Workflows, and Durable Objects. You do not need a Cloudflare account for local development.

## Before you start

- Install Node.js 22.12 or later.
- Enable corepack one time: `corepack enable`. Envelopen runs pnpm through corepack, so you do not install pnpm yourself.
- Install `openssl`, to make the secret values. macOS and most Linux systems have it.

## Steps

### 1. Install the dependencies

```sh
corepack pnpm install
```

### 2. Make the local secrets file

Copy the example file:

```sh
cp .dev.vars.example .dev.vars
```

Replace the three values in `.dev.vars` with new random values:

```sh
SETUP_TOKEN=<output of: openssl rand -hex 32>
ENCRYPTION_KEY=<output of: openssl rand -base64 32>
SIGNING_KEY=<output of: openssl rand -base64 32>
```

Git ignores `.dev.vars`. Do not use these values in production.

### 3. Make the local database

Apply the migrations to the local D1 database:

```sh
corepack pnpm exec wrangler d1 migrations apply DB --local
```

Do this step again after you pull changes that add a migration in `packages/db/migrations`.

### 4. Start the Worker

```sh
corepack pnpm dev
```

This command builds the admin app, then starts `wrangler dev`. Wait for `Ready on http://localhost:8787`.

To check the Worker, open `http://localhost:8787/api/health`. The response is `{"status":"ok"}`.

### 5. Create the owner

1. Open `http://localhost:8787/setup`.
2. In **Setup token**, enter the `SETUP_TOKEN` value from `.dev.vars`.
3. Enter **Your name**, **Email**, and **Password**.
4. In **First workspace**, enter a name for the workspace.

The local `PBKDF2_ITERATIONS` value is 100,000, so the owner signs in with a password.

### 6. Run the cron jobs when you need them

`wrangler dev` does not run the per-minute cron. Without the cron, these jobs do not run:

- Scheduled campaigns do not start.
- A campaign does not change to **Sent** after its last batch.
- The recovery sweep and the cleanup jobs do not run.

To run the cron one time, send this request:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

To run it every minute, keep this loop open in a second terminal:

```sh
while true; do curl -s "http://localhost:8787/cdn-cgi/local/scheduled" > /dev/null; sleep 60; done
```

## Send email from a local Worker

If you connect a real provider, the local Worker sends real email through it. Use only test addresses that you own.

Provider webhooks cannot reach `localhost`. Bounces, complaints, and delivery events from the provider do not arrive locally.

To work without a real provider, use the provider mock from the end-to-end tests. The mock answers as Resend and as the DNS resolver. No request leaves your computer.

1. Start the mock in a second terminal: `node apps/web/e2e/provider-mock.mjs 8788 --dmarc`.
2. Add this line to `.dev.vars`: `OUTBOUND_MOCK_ORIGIN=http://localhost:8788`.
3. Restart `corepack pnpm dev`.
4. In Envelopen, add a Resend connection. Any API key works with the mock.
5. Add the sending domain `mail.example.com`. With `--dmarc`, the mock answers with all of its DNS records, so the domain verifies.

The Worker accepts `OUTBOUND_MOCK_ORIGIN` only with a `localhost` or `127.0.0.1` address. Remove the line when you want to use a real provider.

## Reset the local data

The local data is in `.wrangler/state`. To start again with an empty database:

1. Stop `corepack pnpm dev`.
2. Delete the `.wrangler/state` folder.
3. Do steps 3 to 5 again.

## Run the checks

```sh
corepack pnpm test        # Vitest in the Workers runtime
corepack pnpm test:e2e    # Playwright against local Workers and the provider mock
corepack pnpm typecheck   # TypeScript in all packages
corepack pnpm lint        # Biome
corepack pnpm build       # Web build, then a Worker dry-run build
```

The end-to-end tests need the Playwright browser. Install it one time:

```sh
corepack pnpm --filter @envelopen/web exec playwright install chromium
```

The end-to-end tests start their own Workers with their own data. They do not change your local data in `.wrangler/state`. No test sends real email.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| An API request fails with a `no such table` error in the `wrangler dev` log. | The local database has no migrations. | Do step 3. |
| The setup page does not accept the token. | The token is not the value in `.dev.vars`, or the Worker started before you changed the file. | Check the value. Restart `corepack pnpm dev`. |
| The setup page shows **Go to sign in**. | The owner exists already. | Sign in, or reset the local data. |
| A campaign stays at **Sending** after all batches are done. | The cron did not run. | Run the cron. See step 6. |
| `corepack pnpm` is not found. | corepack is not enabled. | Run `corepack enable`. |

## Related guides

- [README](../../README.md): deploy to Cloudflare, secrets, and the first campaign.
- [Send a test email](test-send.md)
- [Set up a sending domain](sending-domain.md)
