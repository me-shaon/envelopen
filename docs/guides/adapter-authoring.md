# Add an email provider

Last checked: 2026-10-19

This guide tells you how to add an email provider to Envelopen. You write an adapter, record fixtures, run the conformance kit, and write a user guide for the provider. You change files only in `packages/providers` and `docs/guides`.

## What you make

| File | What it holds |
|---|---|
| `packages/providers/src/<id>/index.ts` | The adapter: one exported object of type `ProviderAdapter`. |
| `packages/providers/conformance/fixtures/<id>.ts` | Recorded provider exchanges and the conformance fixtures. |
| `packages/providers/src/<id>/conformance.test.ts` | Three lines that run the kit on your adapter. |
| `packages/providers/src/<id>/<id>.test.ts` | Optional. Tests for provider details that the kit does not cover. |
| `packages/providers/src/index.ts` | Add the adapter to `ADAPTERS`, and export it. |
| `docs/guides/provider-<id>.md` | The user guide, from the template at the end of this guide. |

`<id>` is a short lowercase name, for example `lettermill`. Use the same `<id>` in every file name and in the adapter's `id` field.

## The contract

The contract is in `packages/providers/src/types.ts`. Read that file first. The comments in it are part of the contract.

An adapter is a plain object. It holds data that describes the provider, and functions that call the provider API.

### Data fields

| Field | Rule |
|---|---|
| `id` | Lowercase letters, digits, and dashes. Envelopen stores it, so do not change it later. |
| `name` | The provider name that the owner sees. |
| `policy` | `campaign` when the provider terms allow bulk marketing email. Otherwise `transactional-only`. |
| `policyWarning` | Required for `transactional-only`. Not allowed for `campaign`. The owner must accept this text before a campaign. |
| `credentialFields` | The connect form. Use one field when the provider allows it. Mark a key or token as `secret: true`. At least one field is `required`. Use `apiKey` for a single API key, and `apiToken` for a bearer token. `pattern` is a regular expression source. Anchor it with `^` and `$`. For a choice, such as a region, set `options` (value and label pairs) and `defaultValue`. The form then shows a select, and Envelopen accepts only a listed value. |
| `capabilities` | What the provider can do. See [Capabilities](#capabilities). |
| `facts` | Rate, plan needs, notes, and the documentation URL. Set `requiresWorkersPaid` to true only when the provider cannot work on Workers Free, for example when it needs a paid binding. Each note is one full sentence that ends with a period. Notes tell the owner about rate limits, quotas, missing events, and costs. `docsUrl` starts with `https://`. |
| `dns` | The SPF include and the DKIM selectors for the domain checks. Use `null` and `[]` when they do not apply. |
| `manualSecret` | Who makes the webhook secret in manual setup. `envelopen`: the owner copies the Envelopen secret into the provider. `provider`: the owner pastes the provider secret into Envelopen. `none`: the provider has no webhook. |
| `webhookSecretField` | Optional, for `provider`. The credential field that holds the provider's webhook secret, when the connect form asks for it (Mailgun asks for its signing key). Manual setup then stores the secret too, so the owner does not paste it twice. |

### Functions

| Function | Required | What it does |
|---|---|---|
| `connect(credentials, ctx)` | Yes | Checks the credentials with a cheap API call. It must not send email. On success, `account` is a short description, for example "Course Academy, growth plan". Put problems that do not stop the connection, for example a sandbox, in `warnings`. |
| `sendBatch(messages, credentials, ctx)` | Yes | Sends one batch. It returns one result per message, in the order of the messages. |
| `verifyWebhook(request, secret, ctx)` | Yes | Returns `{ ok: true }` only for a request that the provider sent and that nobody changed. |
| `parseEvents(request)` | Yes | Turns a verified request into `NormalizedEvent` values. |
| `manualSteps(target)` | Yes | Steps for the provider dashboard. One step must show `target.url` when the adapter has a webhook. |
| `setupEvents(credentials, target, ctx)` | When `autoWebhook` is true | Creates the webhook through the provider API. Return `{ mode: "auto", secret, refs }`. Keep the webhook id in `refs`, for example `{ webhookId: "wh_1" }`. On any provider error, return `{ mode: "manual", reason }`. |
| `teardownEvents(credentials, ctx)` | When `setupEvents` exists | Removes what `setupEvents` created. It reads the ids from `ctx.refs`. Envelopen merges the refs of `connect` and `setupEvents` into `ctx.refs`. |
| `webhookUrl(baseUrl, secret)` | No | Changes the webhook URL, for example to add the secret as a query parameter. |
| `domainRecords(credentials, domain, ctx)` | No | Returns the exact DNS records when the provider API lists them. |

### Rules for every function

- Make every HTTP call through `ctx.fetch`. Do not use the global `fetch`. The kit replaces `ctx.fetch` with recorded exchanges.
- Use `callProvider(ctx, url, init)` from `src/shared/http.ts`. It adds the timeout. It returns a timeout or a network error as a value, not as an exception.
- Do not throw for a provider error. Return the error as a result.
- Use only WebCrypto and the Workers globals. Do not use Node.js APIs. The adapter runs in a Worker.
- Use `ctx.now()` for the time when it is set. The kit sets a fixed clock.
- Do not put a credential or a secret in a result message. The owner sees result messages.

### Send results

`sendBatch` returns a `SendBatchResult`. Each `RecipientResult` has an `outcome`:

| Outcome | When | Examples |
|---|---|---|
| `sent` | The provider accepted the message. | 200, or a success item in a 207 response. |
| `not_sent` | The provider refused the message. A retry cannot send a duplicate. | 429, quota, credits, auth, validation 4xx, a refused item. |
| `unknown` | The message may have gone out. | A timeout, a network error, a 5xx. |

Give each result that is not `sent` a `reason` from `FailureReason`:

| Reason | Use it for |
|---|---|
| `rate_limited` | A throttle, usually 429. |
| `quota` | A daily or monthly sending limit. |
| `credits` | No credits or balance left, usually 402. |
| `auth` | A wrong, restricted, or suspended key, or an account that cannot send yet. |
| `validation` | A request or an address that the provider finds not valid. |
| `rejected` | A valid message that the provider refuses: a suppressed address, spam content, an inactive recipient. |
| `server_error` | A 5xx, or a response without a result for the message. |
| `timeout`, `network` | Transport failures. `callProvider` gives these. |

Return one result for each message. If the provider response has fewer items than the request, return `unknown` with `server_error` for each message without an item.

When the whole request fails, set `failure` too. Every result then has the outcome of the failure. Copy `Retry-After` into `failure.retryAfterMs`. Use `retryAfterMs(response, now)` from `src/shared/http.ts` for this, with `now` from `ctx.now()` when it is set. `failBatch(messages, failure)` builds this result for you.

A per-message provider error can also stop the batch, for example a throttle on a per-recipient API. Set `failure` with `not_sent` for the first such error. Return `not_sent` for each message that you did not start.

### Unsubscribe headers

Each campaign and test message carries two headers in `message.headers`:

```
List-Unsubscribe: <https://track.example.com/u/...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Send all of `message.headers` to the provider, unchanged. Gmail and Yahoo require both headers from bulk senders. The kit fails an adapter that drops either header.

If the provider cannot carry custom headers, set `customHeaders: false`. Then the adapter must be `transactional-only`.

## Capabilities

| Capability | Set it to |
|---|---|
| `batchSize` | The messages in one `sendBatch` call. One send runs on Workers Free, with 10 ms of CPU and 50 subrequests (KTD20). For a batch API, keep it at 50 or less, even when the provider takes more. The JSON of a larger batch uses too much CPU. For an API with one request per message, keep it at 25 or less, because each message is one subrequest. |
| `idempotency` | `true` only when the provider accepts an idempotency key. Then send `ctx.idempotencyKey` as the provider's header, and build the same payload for the same messages. When `ctx.idempotencyKey` is not set, do not send the header. |
| `idempotencyWindowMs` | The time that the provider keeps a key, in milliseconds. Use `null` when `idempotency` is false. |
| `rateUnit` | `request` when the provider limits API calls. `recipient` when it limits emails. |
| `eventTypes` | The `ProviderEventType` values that the webhook reports. Use `[]` when `manualSecret` is `none`. |
| `customHeaders` | `true` when the provider passes custom headers unchanged. |
| `autoWebhook` | `true` when `setupEvents` can create the webhook through the API. |

The kit skips a check that a capability turns off. For example, it skips the idempotency check when `idempotency` is false. The test output shows each skip and its reason.

## Write the adapter

1. Read the provider's API reference for the send call, the errors, and the webhook signature.
2. Create `packages/providers/src/<id>/index.ts`.
3. Write `connect` with the cheapest read call of the API.
4. Write `sendBatch`. Map each provider error to an outcome and a reason.
5. Write `verifyWebhook`. Compare signatures with `timingSafeEqual` from `src/shared/encoding.ts`. If the signature has a timestamp, reject a timestamp outside the window in both directions (past and future). If the signature covers a one-time token and not the body (Mailgun), return the token as `nonce` with the end of the window as `expiresAt`. The hook route records it in D1 and rejects a second request with the same token.
6. Write `parseEvents`. Skip event types that are not in `ProviderEventType`. Do not return an error for them.
7. Give each event a stable `eventId`, so a repeated delivery has the same id. Use the provider's event id when it has one.
8. Put a short provider detail in `detail`, for example the bounce subtype. Leave it out when the provider gives none.
9. Write `manualSteps`.
10. Export the adapter, and add it to `ADAPTERS` in `src/index.ts`.

The shared helpers:

| File | Helper | What it does |
|---|---|---|
| `src/shared/http.ts` | `callProvider(ctx, url, init)` | Calls the provider with a timeout. Returns `{ ok: true, response }` or a transport failure. |
| | `readJson(response)` | Reads a JSON body. Returns null for an empty or a bad body. |
| | `classifyStatus(status)` | The default outcome and reason of an HTTP status. Refine it with the provider's error code. |
| | `retryAfterMs(response, now)` | `Retry-After` in milliseconds. |
| | `failBatch(messages, failure)` | A result where every message has the outcome of one failure. |
| | `transportFailure(call)` | The `BatchFailure` of a timeout or a network error. |
| | `shortMessage(text, fallback)` | A safe error text of at most 300 characters. |
| `src/shared/encoding.ts` | `hmacSha256`, `bytesToHex`, `bytesToBase64`, `base64ToBytes`, `utf8` | Byte and HMAC helpers on WebCrypto. |
| | `timingSafeEqual(a, b)` | Compares two signatures in constant time. |
| `src/shared/messages.ts` | `mailboxAddress`, `mailboxName` | Split `Ana <ana@example.com>` into the address and the name. |

## Record fixtures

A fixture is a provider exchange: a request pattern and the recorded response. The kit replays fixtures through `ctx.fetch`. No test calls the real provider.

1. Send each request once to the provider with a test account. Use `curl` or the provider's API console.
2. Copy the response status, the headers that matter (for example `Retry-After`), and the body.
3. Change ids, keys, and addresses to made-up values. Do not commit a real key.
4. Write each exchange as a `RecordedExchange` (from `conformance/mock-fetch.ts`).
5. Add a comment with the documentation URL and the date of the recording.

If the provider has no test account, copy the examples from its API reference. Say so in the comment.

### RecordedExchange

```ts
{
  label: "batch of two, both accepted",   // what the exchange shows
  method: "POST",
  url: "https://api.lettermill.example/v1/batch",   // a string, or a RegExp for URLs with ids
  response: { status: 200, headers: { "retry-after": "2" }, body: { ... } },
  times: 1,   // optional: answer only this many requests
}
```

- `response` can be `"timeout"` or `"network"` to simulate a transport failure.
- `response` can be a function of the captured request. Use a function when the answer depends on the request, for example on the recipient of a per-message API.
- `body` can be an object (sent as JSON) or a string (sent as it is).
- Leave `times` out when the kit sends the same request more than once. The idempotency check sends the `allSent` batch twice.

### The sample messages

The kit sends messages from `conformance/fixtures/messages.ts`. A batch of size 3 holds these messages, in this order:

| Position in the batch | `recipientId` | `to` |
|---|---|---|
| First (index 0) | `r1` | `student1@example.org` |
| Second (index 1) | `r2` | `student2@example.org` |
| Third (index 2) | `r3` | `student3@example.org` |

Each message has `List-Unsubscribe: <https://track.example.com/u/token<n>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Write your recorded responses for these recipients.

### ConformanceFixtures

The format is in `packages/providers/conformance/fixtures/types.ts`. Export one `ConformanceFixtures` object from your fixture file.

| Field | Required | What it holds |
|---|---|---|
| `credentials` | Yes | Made-up credentials in the shape of `credentialFields`. |
| `refs` | No | The refs that `connect` and `setupEvents` return. The kit passes them in every `ctx`. |
| `now` | No | A fixed clock, in Unix milliseconds. Set it when the webhook signature has a timestamp. |
| `emailHeaders(request)` | Yes | Reads the headers of each email from one captured request. Return one record per email. |
| `send.allSent` | Yes | Every recipient is accepted. |
| `send.partial` | Yes | Some recipients pass and some fail. `expected` lists the outcome (and optionally the reason) of each recipient, in order. |
| `send.retryable` | Yes | A throttle. Set `reason: "rate_limited"` and `retryAfterMs`. |
| `send.permanent` | Yes | A failure that a retry does not fix. Set `reason` to `auth`, `quota`, or `credits`. |
| `send.uncertain` | Yes | A 5xx. |
| `connect.ok` | Yes | The exchanges of a good key. |
| `connect.badKey` | Yes | The exchanges of a wrong key. |
| `connect.badKeyReason` | No | The reason for a wrong key. The default is `auth`. |
| `webhook` | When `manualSecret` is not `none` | The webhook fixtures. See below. |
| `events` | When `manualSecret` is not `none` | Bodies for `parseEvents` and the events that each body gives. |
| `skip` | No | Check ids that do not apply, with the reason. |

`emailHeaders` reads the captured request, not the messages. This is how the kit sees what the provider gets. Change the example to the body shape of your provider. Example for a JSON body `{ "messages": [{ "headers": { ... } }] }`:

```ts
emailHeaders: (request) =>
  (JSON.parse(request.body) as { messages: { headers: Record<string, string> }[] }).messages.map(
    (email) => email.headers,
  ),
```

For an API with one request per message, return a list with one record.

`webhook` holds:

| Field | What it holds |
|---|---|
| `secret` | The secret that signed `valid`. |
| `valid()` | A request that the provider signed with `secret`, at `now`. It can be async. |
| `stale()` | A request signed with a timestamp outside the provider's window. Leave it out when the signature has no timestamp, and add a skip reason. |
| `tamper(request)` | Optional. It changes the content but keeps the signature. The default adds `x` to the first string in the JSON body. Write your own when the signature covers parsed fields, not the raw body. |
| `wrongSecret` | Optional. The default is a random secret. |
| `exchanges` | Optional. Exchanges that verification needs, for example a signing certificate. |
| `refs` | Optional. Refs for the verify call only. |

Sign `valid()` with the provider's algorithm. Write a small signer in the fixture file, or reuse the adapter's signer when it exports one.

`events` is a list of `{ label, request(), expected }`. `parseEvents` gets a request that is already verified, so the event requests do not need a signature. Signed requests also work. `expected` lists the fields to compare for each event, in order. Use `expected: []` for a body that the adapter must skip, for example an open event. Together, the event fixtures must give every type in `capabilities.eventTypes`.

### SMTP adapters

An adapter that sends over TCP uses `ctx.connect`, not `ctx.fetch`. Its fixtures set `smtp` in place of `exchanges`. The value is the behavior of the in-process mock server in `conformance/mock-smtp.ts`, for example a `reply` function that answers `RCPT` with a 550.

- Each send fixture sets `smtp`. The kit passes the mock's `connect` and a fetch that fails.
- `connect.smtp` sets the server for a good login (`ok`) and a wrong login (`badKey`). Leave `connect.ok` and `connect.badKey` empty.
- `emailHeaders` gets one request per accepted message. The body is the message source. Read it with `parseMail` from `conformance/mock-smtp.ts`.
- For a timeout, the kit lets the server ignore the final dot of DATA. For a server error, it answers the greeting with 421.

See `conformance/fixtures/smtp.ts` for a full example.

### Skip a check

Add the check id and a reason to `skip`:

```ts
skip: {
  "webhook.stale": "The provider signs only the body, with no timestamp.",
},
```

You cannot skip these checks: `declaration`, `policy`, `send.all-sent`, `send.headers`, `webhook.valid`, `events.parse`, `connect.ok`, `connect.bad-key`, and `connect.server-error`. A skip entry for one of them makes the check fail.

A check without its fixture and without a skip reason fails. The failure tells you which fixture to add.

## Run the kit

1. Create `packages/providers/src/<id>/conformance.test.ts`:

   ```ts
   import { lettermillConformance } from "../../conformance/fixtures/lettermill";
   import { runConformance } from "../../conformance/suite";
   import { lettermillAdapter } from "./index";

   runConformance(lettermillAdapter, lettermillConformance);
   ```

2. Run the kit for your adapter:

   ```sh
   pnpm --filter @envelopen/providers exec vitest run src/<id>/conformance.test.ts --reporter=verbose
   ```

3. Read each failure. A failure lists each problem as one sentence.
4. Fix the adapter or the fixture, and run the kit again.
5. Run all checks of the repository before you open a pull request:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

CI runs `pnpm test`, so the kit runs for every adapter on each push.

### The checks

| Id | What it proves | Skipped when |
|---|---|---|
| `declaration` | The capabilities, the facts, and the credential fields are complete and consistent. | Never |
| `policy` | The policy is valid. `transactional-only` has a warning. `campaign` has no warning and passes custom headers. | Never |
| `send.all-sent` | An accepted batch gives one `sent` result per message, in order. | Never |
| `send.partial` | A partial failure gives the right outcome for each recipient. | Skip reason |
| `send.headers` | Both unsubscribe headers reach the provider request, for each email. | `customHeaders` is false |
| `send.idempotency` | The key reaches the provider, and a retry sends the same payload. | `idempotency` is false |
| `send.retryable` | A throttle is `not_sent` and `rate_limited`, with `retryAfterMs`. | Skip reason |
| `send.permanent` | Auth, quota, or credits is `not_sent`, with `failure` set. | Skip reason |
| `send.uncertain` | A 5xx and a timeout give `unknown` for each recipient. | Skip reason |
| `webhook.valid` | A valid request passes. Without a webhook, every request fails. | Never |
| `webhook.changed` | A changed payload fails. | No webhook, or skip reason |
| `webhook.wrong-secret` | A wrong secret and an empty secret fail. | No webhook, or skip reason |
| `webhook.stale` | A stale timestamp fails. | No webhook, or skip reason |
| `events.parse` | Events have contract types, stable ids, and valid times. Every declared type has a fixture. | Never |
| `connect.ok` | A good key connects. | Never |
| `connect.bad-key` | A wrong key fails with the expected reason. | Never |
| `connect.server-error` | A 503 gives `server_error`, and a network error gives `network`. The kit makes these answers itself. | Never |

The kit calls `adapter.sendBatch` directly. In production, `sendBatch` in `src/shared/messages.ts` repairs a missing result. The kit does not repair it, so the kit finds the fault.

The kit does not call `setupEvents`, `teardownEvents`, or `domainRecords`. Test them in `src/<id>/<id>.test.ts` with `mockFetch` from `conformance/mock-fetch.ts`.

To use the checks without Vitest, call `runChecks(adapter, fixtures)` from `conformance/checks.ts`. It returns one result per check.

## Write the user guide

Each provider has a guide in `docs/guides/provider-<id>.md`. Copy this template. Write it in short sentences. Give the date of each check.

```markdown
# <Provider name>

Last checked: YYYY-MM-DD

## What Envelopen uses it for

<One or two sentences: what Envelopen sends through the provider, and which events it gets back.>

## Cost and free tier

- <Price per 1,000 emails.>
- <Free tier, monthly minimum, and credits.>

## Limits and constraints

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Batch send | <Endpoint and size.> | <How Envelopen sends.> |
| Rate limit | <Value, or "Not documented".> | <Start rate and back-off.> |
| Idempotency | <Key and window, or "None".> | <What happens after a timeout.> |
| Webhook events | <Event list.> | <What Envelopen shows.> |
| Webhook signature | <Algorithm and header.> | <How Envelopen verifies it.> |
| Custom headers | <Supported or not.> | <Effect on List-Unsubscribe and List-Unsubscribe-Post.> |

## When to choose it, and when not to

- Choose it when <...>.
- Do not choose it when <...>.

## Setup

1. <Step in the provider dashboard.>
2. <Step.>

## Connect to Envelopen

1. Open Settings, then Providers, and select <Provider name>.
2. <Paste the key.>
3. <Webhook: automatic, or the manual steps.>

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| <Error text.> | <Cause.> | <Fix.> |

## Sources

- <Official URL> (checked YYYY-MM-DD)
```

Add a row for the new guide to the table in `docs/guides/README.md`.

## Checklist

- [ ] The adapter is in `src/<id>/index.ts` and in `ADAPTERS`.
- [ ] Every HTTP call goes through `ctx.fetch`.
- [ ] The fixtures have made-up ids and keys, a source URL, and a date.
- [ ] Each skip has a reason that a reviewer can check.
- [ ] `src/<id>/conformance.test.ts` passes.
- [ ] `pnpm lint`, `typecheck`, and `test` pass.
- [ ] `docs/guides/provider-<id>.md` follows the template.
- [ ] No file outside `packages/providers` and `docs/guides` changed.
