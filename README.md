# Envelopen

Envelopen is a self-hosted email marketing tool on Cloudflare Workers. It sends campaigns through the email provider that you already use.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/me-shaon/envelopen)

The button creates the D1 database, the KV namespace, the R2 bucket, and the queues. The deploy script applies the D1 migrations.

## Secrets

The Deploy button asks for these values. `.dev.vars.example` explains each one.

| Name | Purpose | Generate with |
|---|---|---|
| `SETUP_TOKEN` | Opens the first-run setup screen. Use at least 32 characters. | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Encrypts provider credentials. | `openssl rand -base64 32` |
| `SIGNING_KEY` | Signs tracking and unsubscribe tokens. The login session secret is derived from it. | `openssl rand -base64 32` |

The `PBKDF2_ITERATIONS` variable in `wrangler.jsonc` sets the password hash cost (at most 100000). Below 100000, the owner signs in with a passkey. `apps/worker/scripts/pbkdf2-benchmark/worker.ts` explains how to measure the cost on your account.

## First run

Open the app after the deploy. The first-run screen asks for `SETUP_TOKEN`, checks the bindings and the migrations, shows the plan limits, and creates the owner and the first workspace. If the owner loses the password or the passkey, the same token resets it. The screen stays closed when `SETUP_TOKEN` is missing or shorter than 32 characters.

## Local development

pnpm runs through corepack. Node.js 22.12 or later is necessary.

```sh
corepack pnpm install
cp .dev.vars.example .dev.vars
corepack pnpm dev
```

Other commands:

```sh
corepack pnpm test        # Vitest in the Workers runtime
corepack pnpm typecheck   # TypeScript in all packages
corepack pnpm lint        # Biome
corepack pnpm build       # Web build, then a Worker dry-run build
corepack pnpm cf-typegen  # Regenerate Worker types after a wrangler.jsonc change
```

## Layout

- `apps/web`: React admin app, served as static assets.
- `apps/worker`: Hono Worker for the API, tracking, webhooks, the queue consumer, and cron.
- `packages/core`, `packages/db`, `packages/providers`, `packages/email-render`: shared code.
- `wrangler.jsonc`: one Worker configuration at the repository root.
