# Envelopen

Envelopen is a self-hosted email marketing tool that runs on Cloudflare Workers. It sends campaigns through an email provider that you already use: Amazon SES, Resend, or Postmark. toSend and Cloudflare Email can send system email and test sends.

Your contacts and stats stay in your own Cloudflare account. Envelopen has an admin app, a REST API, and an MCP server for AI agents. All three use the same rules.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/me-shaon/envelopen)

1. Select the button above, and sign in to Cloudflare.
2. Enter the three secrets (see [Secrets](#secrets)).
3. Wait for the build and the deploy to finish.

The button creates the D1 database, the KV namespace, the R2 bucket, the queues with the dead-letter queue, the Workflows, and the Durable Objects. The deploy script applies the D1 migrations.

Envelopen runs on the Workers Free plan. Free has daily limits, for example 100,000 D1 rows written each day. For regular campaigns, use Workers Paid (5 USD per month). The [platform guide](docs/guides/cloudflare-platform.md) shows what happens at each limit.

## Secrets

The Deploy button asks for these values. `.dev.vars.example` explains each one.

| Name | Purpose | Generate with |
|---|---|---|
| `SETUP_TOKEN` | Opens the first-run setup screen. Use at least 32 characters. | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Encrypts provider credentials (AES-GCM). 32 bytes, base64. | `openssl rand -base64 32` |
| `SIGNING_KEY` | Signs tracking and unsubscribe tokens. The login session secret and the suppression hash come from it. 32 bytes, base64. | `openssl rand -base64 32` |
| `SIGNING_KEYS_RETIRED` | Optional. Earlier `SIGNING_KEY` values, comma-separated. | Not generated |

To set or change a secret after the deploy, run this command from the repository root:

```sh
npx wrangler secret put SIGNING_KEY
```

Wrangler asks for the value. The Worker uses the new value at once.

Keep `SIGNING_KEY` stable. A new value signs everyone out. It also changes the hash of every suppressed address, so old suppressions stop matching. If you must replace it, put the old value in `SIGNING_KEYS_RETIRED`. Unsubscribe links in emails that you already sent then keep working.

The `PBKDF2_ITERATIONS` variable in `wrangler.jsonc` sets the password hash cost (at most 100,000). Below 100,000, the owner signs in with a passkey. The [release checklist](docs/guides/release-checklist.md) shows how to measure the cost on your account.

## First-run setup

1. Open the URL of the Worker. Envelopen opens `/setup`.
2. Type the `SETUP_TOKEN`, and select **Check the deployment**.
3. Check that all deployment checks pass, and read the plan limits.
4. Select **Continue**.
5. Type your name, your email, your password, and the name of the first workspace.
6. Select **Create the owner**.

The setup screen closes after the owner exists. If the owner loses the password or the passkey, the same token resets it at `/recover`. The screen stays closed when `SETUP_TOKEN` is missing or shorter than 32 characters.

## Send your first campaign

The overview shows a "Finish setting up" checklist with a link for each step.

### 1. Connect a provider

1. Open **Connections**.
2. Select **Connect** on the card of your provider.
3. Paste the API key, and select **Connect**.

For Resend, Postmark, and Amazon SES, Envelopen creates the webhook for bounces and complaints. For toSend and Cloudflare Email, follow the manual steps in the dialog. Read the guide of your provider first:

- [Amazon SES](docs/guides/provider-ses.md)
- [Resend](docs/guides/provider-resend.md)
- [Postmark](docs/guides/provider-postmark.md)
- [toSend](docs/guides/provider-tosend.md) (transactional only)
- [Cloudflare Email](docs/guides/provider-cloudflare-email.md) (transactional only)

### 2. Verify a sending domain

1. Open **Connections**, then **Sending domains**.
2. Type the domain, for example `mail.example.com`, and select **Add domain**.
3. Add the DNS records that Envelopen shows at your DNS host.
4. Wait for SPF, DKIM, and DMARC to show **Verified**.

See [Set up a sending domain](docs/guides/sending-domain.md).

### 3. Import contacts

1. Open **Contacts**, and select **Import a CSV**.
2. Upload the file, and map the columns.
3. Select the consent basis of the contacts. Add tags or lists if you want.
4. Select **Preview the import**, and read the counts.
5. Select **Import N contacts**.

Envelopen skips addresses that are unsubscribed or suppressed. See [Import contacts](docs/guides/import-contacts.md).

### 4. Create a template and send a test

1. Open **Templates**, and select **New template**.
2. Type a name and a subject, and write the email with blocks.
3. Select **Save**.
4. Select **Send test**, and select **Send test** in the dialog.

Check the test email in your inbox. See [Send a test email](docs/guides/test-send.md) for the unsubscribe header check.

### 5. Create and send the campaign

1. Open **Campaigns**, and select **New campaign**.
2. Type the campaign name, select the template, and type the From name and the From address.
3. Select the lists or tags of the audience.
4. Select **Create draft**.
5. Select **Review and send**, then **Check and continue**.
6. Read the checklist, the provider, and the recipient estimate.
7. Select **Send to about N people**.

The campaign page shows the progress, then **Sent**. Opens, clicks, and unsubscribes show in the stats after some seconds.

## Contact data rights

On the page of a contact:

- **Export data** downloads a JSON file with the contact, list memberships, consent history, campaigns, and events. Use it for a data access request.
- **Erase** removes the personal data of the contact. Type the email address to confirm. Campaign totals stay. A keyed hash of the address stays on the suppression list, so an import cannot add the contact back.

The REST API has the same actions: `POST /api/contacts/{id}/export` and `POST /api/contacts/{id}/erase`.

## Audit log

Envelopen records every change with the actor, the surface (UI, API, or MCP), and the target. Exports and erases are in it too. Open **Settings**, then select **Open the audit log**. You can filter by surface and by action.

## API and MCP

- The REST API is under `/api`. Create an API key in **Settings** > **API keys**. Send it as `Authorization: Bearer evk_...`. The OpenAPI document is in `apps/web/src/api/openapi.json`.
- The MCP server is at `/mcp`. It accepts API keys only. See [Connect an MCP client](docs/guides/mcp.md).

## Local development

pnpm runs through corepack. Node.js 22.12 or later is necessary.

```sh
corepack pnpm install
cp .dev.vars.example .dev.vars
corepack pnpm dev
```

Replace the values in `.dev.vars` before you start. Then open `http://localhost:8787/setup`.

Other commands:

```sh
corepack pnpm test        # Vitest in the Workers runtime
corepack pnpm test:e2e    # Playwright against local Workers and a mock provider
corepack pnpm typecheck   # TypeScript in all packages
corepack pnpm lint        # Biome
corepack pnpm build       # Web build, then a Worker dry-run build
corepack pnpm openapi     # Regenerate the OpenAPI document and the client types
corepack pnpm cf-typegen  # Regenerate Worker types after a wrangler.jsonc change
```

The end-to-end tests need the Playwright browsers. Install them one time with `corepack pnpm --filter @envelopen/web exec playwright install chromium`. No test sends real email.

## Layout

- `apps/web`: the React admin app, served as static assets.
- `apps/worker`: the Hono Worker for the API, MCP, tracking, webhooks, the queue consumer, and cron.
- `packages/core`: the operation registry and the services.
- `packages/db`: the D1 schema, the migrations, and the metered connection.
- `packages/providers`: the provider adapters and the conformance kit.
- `packages/email-render`: the email blocks and personalization.
- `wrangler.jsonc`: one Worker configuration at the repository root.

## Guides

All guides are in [docs/guides](docs/guides/README.md):

- [Cloudflare Workers platform](docs/guides/cloudflare-platform.md) and [Cloudflare D1](docs/guides/database-d1.md)
- [Provider guides](docs/guides/README.md#email-providers)
- [Set up a sending domain](docs/guides/sending-domain.md)
- [Import contacts](docs/guides/import-contacts.md)
- [Send a test email](docs/guides/test-send.md)
- [Connect an MCP client](docs/guides/mcp.md)
- [Write a provider adapter](docs/guides/adapter-authoring.md)
- [Release checklist](docs/guides/release-checklist.md)
