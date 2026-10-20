# Release checklist

The automated tests run in the local Workers runtime with mocked providers. Some facts need a real deployment, a real provider, or a real inbox. Do these checks before a release, and record each result with the date.

Use a separate Cloudflare account on the Workers Free plan for the deploy checks, if you can. Free has the tightest limits. Never send to real people during these checks. Send only to your own addresses.

## 1. Deploy button on a Free account

Expected result: the button provisions every binding, and the first-run screen shows "9 of 9 pass".

1. Open the Deploy to Cloudflare link in the [README](../../README.md) with a Free account.
2. Enter `SETUP_TOKEN`, `SIGNING_KEY`, and `ENCRYPTION_KEY`.
3. Wait for the build and the deploy to finish.
4. In the dashboard, check that these exist: the D1 database, the KV namespace, the R2 bucket, `send-queue`, `send-queue-dlq`, the import Workflow, the campaign Workflow, and the four Durable Object classes.
5. Open `/setup` on the Worker, and type the setup token.
6. Check that the deployment check shows "9 of 9 pass".

Record if the dead-letter queue exists on Free. The plan lists this as an open question.

## 2. PBKDF2 cost and the 100,000 cap

Expected result: the largest iteration count with p99 CPU time below about 8 ms, and a cap of 100,000.

1. From the repository root, deploy the benchmark Worker: `npx wrangler deploy --config apps/worker/scripts/pbkdf2-benchmark/wrangler.jsonc`.
2. Send about 20 requests for each count:

   ```sh
   for n in 10000 25000 50000 75000 100000; do
     for i in $(seq 20); do curl -s "https://<worker-url>/?op=verify&iterations=$n" >/dev/null; done
   done
   ```

3. Read the CPU time of each request in **Workers & Pages** > **envelopen-pbkdf2-benchmark** > **Logs**. You can also use `npx wrangler tail --format json` and read `cpuTime`.
4. Select the largest count whose p99 CPU time stays below about 8 ms.
5. Set `PBKDF2_ITERATIONS` in `wrangler.jsonc` to that count. Below 100,000, the first-run screen enrolls a passkey instead of a password.
6. Probe the cap: `curl "https://<worker-url>/cap"`. Expect 100,000 to work and 100,001 to fail.
7. Delete the Worker: `npx wrangler delete --name envelopen-pbkdf2-benchmark`.

## 3. Personalization benchmark

Expected result: a batch of 50 recipients has p99 CPU time below about 5 ms.

1. Deploy the benchmark Worker: `npx wrangler deploy --config apps/worker/scripts/personalize-benchmark/wrangler.jsonc`.
2. Send about 20 requests for each batch size:

   ```sh
   for n in 10 25 50 100; do
     for i in $(seq 20); do curl -s "https://<worker-url>/?recipients=$n" >/dev/null; done
   done
   ```

3. Repeat step 2 with `&tracking=off` added to the URL.
4. Read `cpuTime` in the Logs, or with `npx wrangler tail --config apps/worker/scripts/personalize-benchmark/wrangler.jsonc --format json`.
5. If the batch of 50 is above 5 ms, lower the default batch size of the adapters in `packages/providers`.
6. Delete the Worker: `npx wrangler delete --name envelopen-personalize-benchmark`.

## 4. CPU per send batch on Free

Expected result: no "Exceeded CPU time limit" error in the send consumer, for each campaign provider.

1. On the Free deployment, import about 200 of your own test addresses. Use plus addresses, for example `you+1@gmail.com`.
2. Send a campaign to them through each campaign provider in turn (Amazon SES, Resend, Postmark).
3. Run `npx wrangler tail --format json` during the send.
4. Read `cpuTime` of each queue invocation, and look for errors.
5. Record the p99 CPU time per provider. If a provider is near 10 ms, lower its batch size.
6. Record if D1 calls count toward the 50 or the 1,000 subrequest limit. The plan lists this as an open question.

## 5. Unsubscribe headers in Gmail

Expected result: both headers are present, and SPF, DKIM, and DMARC pass, for each campaign provider.

Do this for Amazon SES, Resend, and Postmark:

1. Connect the provider, and verify the sending domain.
2. Send a campaign to a list that holds only your Gmail address.
3. In Gmail on the web, open the email, open the menu next to **Reply**, and select **Show original**.
4. Check that `List-Unsubscribe` holds an `https` URL with `/u/` and a token.
5. Check that `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click`.
6. Check that SPF, DKIM, and DMARC show **PASS**.

For Postmark, do the check before and after Postmark support turns on custom unsubscribe handling. See the [Postmark guide](provider-postmark.md).

## 6. One-click unsubscribe from Gmail and Yahoo

Expected result: the contact shows as unsubscribed in Envelopen, with the source "One-click unsubscribe" and the campaign.

1. Send a campaign to your Gmail address and to your Yahoo address.
2. In Gmail, select **Unsubscribe** next to the sender name, and confirm.
3. In Yahoo Mail, select **Unsubscribe** at the top of the email, and confirm.
4. In Envelopen, open each contact.
5. Check the banner "Unsubscribed from every list" with the source and the campaign number.
6. Check the stats of the campaign: **Unsubscribed** counts both contacts.

Gmail can take some minutes to send the POST request.

## 7. Real Queue redelivery

Expected result: a batch that fails with an unknown result is sent again after the lease ends, and no recipient gets two emails from an idempotent provider.

1. Connect Resend (idempotent).
2. Start a campaign to about 100 of your own test addresses.
3. During the send, make one consumer invocation fail. For example, deploy a build that throws after the provider call for one batch.
4. Deploy the normal build again.
5. Wait for the sweep (every minute) and the lease time.
6. Check that the batch is retried with the same idempotency key, and that each address got one email.
7. Check that `send-queue-dlq` holds no message, or only the message of the failed invocation.

## 8. Apple Mail Privacy Protection

Expected result: an open from Apple Mail with protection on is a machine open, not a human open.

1. On an iPhone or a Mac, turn on **Protect Mail Activity** in Mail settings.
2. Send a campaign to an address that this Mail app reads.
3. Open the email in Apple Mail.
4. Run `npx wrangler tail --format json`, and find the request to `/t/o/`.
5. Record `cf.asn` and the `User-Agent` of the request. Envelopen expects ASN 714 and a bare user agent (`apps/worker/src/tracking/classify.ts`).
6. Check the campaign stats: the open shows in machine opens, not in **Opened**.
7. If the values differ, update the classifier with the recorded values.

## 9. A real MCP client against a deployed Worker

Expected result: the agent completes the first-campaign flow through MCP only.

1. Create an API key with the **Agent sender** preset.
2. Add the server to a real MCP client. See [Connect an MCP client](mcp.md).
3. Ask the agent to call `get_workspace_context`.
4. Ask the agent to upsert two of your own addresses, to create a Markdown template, and to create a draft.
5. Ask the agent to send a test email.
6. Ask the agent to prepare the send and to show the estimate.
7. Ask the agent to confirm the send.
8. Check that the campaign reaches **Sent**.
9. Open the audit log, filter by the surface **MCP**, and check that each write shows the API key.

## 10. First campaign from the README only

Expected result: a new user sends a test campaign with only the README and the guides.

1. Give the README to a person who has not used Envelopen.
2. Ask the person to deploy, connect a provider with its API key, verify a domain, import contacts, and send a test campaign.
3. Record each step where the person needed help, and fix the guide.

## Open questions to record

The plan leaves these questions for a deployed check. Record the answers here:

- The PBKDF2 iteration count that fits the Free CPU budget (check 2).
- The default batch size per adapter that fits 10 ms CPU (checks 3 and 4).
- Whether SES `{{{ }}}` renders a full HTML body safely in `SendBulkEmail`.
- Whether D1 calls count toward the 50 or the 1,000 subrequest limit on Free (check 4).
- Whether Cloudflare Email event subscriptions carry delivery events and work on Free.
- The bot-click time window, from real traffic.
- The TTL of confirm tokens and of the lease on claimed batches.
- The sweep timeout for `enqueued` batches, compared with the normal queue backlog on Free.
- Whether the Deploy button provisions the dead-letter queue on a Free account (check 1), and the Queues operation count for a 5,000-recipient campaign.

Last checked: 2026-10-20
