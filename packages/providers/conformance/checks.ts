import { randomSecret } from "../src/shared/encoding";
import {
  assertMessages,
  LIST_UNSUBSCRIBE,
  LIST_UNSUBSCRIBE_POST,
  ONE_CLICK_VALUE,
} from "../src/shared/messages";
import {
  type FailureReason,
  type OutgoingMessage,
  PROVIDER_EVENT_TYPES,
  type ProviderAdapter,
  type SendBatchResult,
  type SendContext,
  type WebhookRequest,
} from "../src/types";
import { campaignBatch } from "./fixtures/messages";
import type { CheckId, ConformanceFixtures, SendFixture } from "./fixtures/types";
import { type CapturedRequest, mockFetch, type RecordedExchange } from "./mock-fetch";

// The checks of the conformance kit (KTD15), as plain functions. Each check returns a
// result and never throws, so the kit can test itself: a broken adapter must fail.
// `suite.ts` wraps these checks in Vitest.

export type CheckStatus =
  | { status: "pass" }
  | { status: "fail"; problems: string[] }
  | { status: "skip"; reason: string };

export interface ConformanceCheck {
  id: CheckId;
  title: string;
  /** Set when the check does not apply. The suite shows it as skipped with this reason. */
  skip?: string;
  run(): Promise<CheckStatus>;
}

export type CheckReport = { id: CheckId; title: string } & CheckStatus;

/** Checks that prove the core of the contract. A fixture cannot skip them. */
const REQUIRED: readonly CheckId[] = [
  "declaration",
  "policy",
  "send.all-sent",
  "send.headers",
  "webhook.valid",
  "events.parse",
  "connect.ok",
  "connect.bad-key",
  "connect.server-error",
];

const FAILURE_REASONS: readonly FailureReason[] = [
  "rate_limited",
  "quota",
  "credits",
  "auth",
  "validation",
  "rejected",
  "server_error",
  "timeout",
  "network",
];

const HOOK_URL = "https://envelopen.test/hooks/conformance/1/2";

/** A request that no provider signed. */
function strangerRequest(): WebhookRequest {
  return {
    url: HOOK_URL,
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ type: "email.bounced", data: { to: ["someone@example.org"] } }),
  };
}

function cloneRequest(request: WebhookRequest, body = request.body): WebhookRequest {
  return { ...request, headers: new Headers(request.headers), body };
}

/** Appends "x" to the first string value of a JSON body, or to a body that is not JSON. */
function defaultTamper(request: WebhookRequest): WebhookRequest {
  let value: unknown;
  try {
    value = JSON.parse(request.body);
  } catch {
    return cloneRequest(request, `${request.body}x`);
  }
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (changed) return node;
    if (typeof node === "string") {
      changed = true;
      return `${node}x`;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  const next = walk(value);
  return cloneRequest(request, changed ? JSON.stringify(next) : `${request.body} x`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The value of a header, by a name in any case. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

const throwingFetch = (error: () => Error): typeof fetch =>
  (async () => {
    throw error();
  }) as typeof fetch;

export function conformanceChecks(
  adapter: ProviderAdapter,
  fixtures: ConformanceFixtures,
): ConformanceCheck[] {
  const caps = adapter.capabilities;
  const hasWebhook = adapter.manualSecret !== "none";

  function context(fetcher: typeof fetch, refs = fixtures.refs ?? {}): SendContext {
    const now = fixtures.now;
    return { fetch: fetcher, refs, ...(now === undefined ? {} : { now: () => now }) };
  }

  async function send(
    fixture: SendFixture,
    options: { idempotencyKey?: string; fetch?: typeof fetch; exchanges?: RecordedExchange[] } = {},
  ): Promise<{
    messages: OutgoingMessage[];
    result: SendBatchResult;
    calls: CapturedRequest[];
  }> {
    const messages = campaignBatch(fixture.size ?? 2);
    // The same check as `sendBatch`, but the kit calls the adapter directly, so a
    // missing or reordered result is a failure here and not repaired.
    assertMessages(messages, caps.batchSize);
    const mock = mockFetch(options.exchanges ?? fixture.exchanges);
    const ctx = {
      ...context(options.fetch ?? mock.fetch),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    };
    const result = await adapter.sendBatch(messages, fixtures.credentials, ctx);
    return { messages, result, calls: mock.calls };
  }

  /** One result per message, in order, with the same recipient ids. */
  function checkShape(
    messages: readonly OutgoingMessage[],
    result: SendBatchResult,
    problems: string[],
  ): boolean {
    if (!Array.isArray(result?.results)) {
      problems.push("sendBatch returned no results array.");
      return false;
    }
    if (result.results.length !== messages.length) {
      problems.push(
        `sendBatch returned ${result.results.length} results for ${messages.length} messages.`,
      );
      return false;
    }
    messages.forEach((message, index) => {
      const item = result.results[index];
      if (item?.recipientId !== message.recipientId) {
        problems.push(
          `Result ${index} is for ${item?.recipientId}, not ${message.recipientId}. Keep the order of the messages.`,
        );
      }
      if (item && !["sent", "not_sent", "unknown"].includes(item.outcome)) {
        problems.push(`Result ${index} has the outcome ${String(item.outcome)}.`);
      }
      if (item && item.outcome !== "sent" && !item.reason) {
        problems.push(`Result ${index} is ${item.outcome} without a reason.`);
      }
      if (item?.reason && !FAILURE_REASONS.includes(item.reason)) {
        problems.push(`Result ${index} has the unknown reason ${item.reason}.`);
      }
    });
    return problems.length === 0;
  }

  /** The skip reason of a check, from the capabilities first, then from the fixtures. */
  function skipReason(id: CheckId, capability?: string): string | undefined {
    if (capability) return capability;
    const reason = fixtures.skip?.[id];
    // A required check with a skip entry runs, and fails on the entry (see `check`).
    if (reason && REQUIRED.includes(id)) return undefined;
    return reason;
  }

  function check(
    id: CheckId,
    title: string,
    body: (problems: string[]) => Promise<void> | void,
    capabilitySkip?: string,
  ): ConformanceCheck {
    const skip = skipReason(id, capabilitySkip);
    return {
      id,
      title,
      ...(skip ? { skip } : {}),
      async run() {
        if (skip) return { status: "skip", reason: skip };
        const problems: string[] = [];
        if (fixtures.skip?.[id] && REQUIRED.includes(id)) {
          problems.push(`The check ${id} cannot be skipped. Remove it from fixtures.skip.`);
        }
        try {
          await body(problems);
        } catch (error) {
          problems.push(`The check threw: ${errorText(error)}`);
        }
        return problems.length > 0 ? { status: "fail", problems } : { status: "pass" };
      },
    };
  }

  function missing(problems: string[], id: CheckId, what: string): void {
    problems.push(`Add ${what} to the fixtures, or add a reason to fixtures.skip["${id}"].`);
  }

  /** Sends a fixture that fails the whole batch, and checks the failure. */
  async function failedBatch(
    problems: string[],
    fixture: NonNullable<ConformanceFixtures["send"]["retryable"]>,
    kind: "retryable" | "permanent",
  ): Promise<void> {
    const { messages, result } = await send(fixture);
    if (!checkShape(messages, result, problems)) return;
    const failure = result.failure;
    if (!failure) {
      problems.push("A failed batch must set `failure`, so the sender can pause or back off.");
      return;
    }
    if (failure.outcome !== "not_sent") {
      problems.push(`A ${kind} failure must be not_sent, not ${failure.outcome}.`);
    }
    if (failure.reason !== fixture.reason) {
      problems.push(`failure.reason is ${failure.reason}. The fixture expects ${fixture.reason}.`);
    }
    if (kind === "retryable" && failure.reason !== "rate_limited") {
      problems.push(`A retryable failure is rate_limited, not ${failure.reason}.`);
    }
    if (kind === "permanent" && !["auth", "quota", "credits"].includes(failure.reason)) {
      problems.push(`A permanent failure is auth, quota, or credits, not ${failure.reason}.`);
    }
    if (fixture.retryAfterMs !== undefined && failure.retryAfterMs !== fixture.retryAfterMs) {
      problems.push(
        `failure.retryAfterMs is ${failure.retryAfterMs}. Retry-After gives ${fixture.retryAfterMs}.`,
      );
    }
    result.results.forEach((item, index) => {
      if (item.outcome !== "not_sent") {
        problems.push(`Result ${index} is ${item.outcome}. Every recipient must be not_sent.`);
      }
    });
  }

  async function verify(request: WebhookRequest, secret: string) {
    const webhook = fixtures.webhook;
    const mock = mockFetch(webhook?.exchanges ?? []);
    return adapter.verifyWebhook(request, secret, context(mock.fetch, webhook?.refs));
  }

  /** Verifies the valid request first, so a rejection later means something. */
  async function validFirst(problems: string[]): Promise<WebhookRequest | null> {
    const webhook = fixtures.webhook;
    if (!webhook) return null;
    const request = await webhook.valid();
    const result = await verify(cloneRequest(request), webhook.secret);
    if (!result.ok) {
      problems.push(`The valid request fails (${result.reason}), so this check proves nothing.`);
      return null;
    }
    return request;
  }

  const noWebhook = hasWebhook ? undefined : "The adapter has no webhook (manualSecret is none).";

  return [
    check("declaration", "declares its capabilities and facts", (problems) => {
      if (!/^[a-z][a-z0-9-]*$/.test(adapter.id)) {
        problems.push(`The id ${adapter.id} must be lowercase letters, digits, and dashes.`);
      }
      if (!adapter.name?.trim()) problems.push("The name is empty.");
      const names = adapter.credentialFields.map((field) => field.name);
      if (names.length === 0) problems.push("Declare at least one credential field.");
      if (new Set(names).size !== names.length) problems.push("Credential field names repeat.");
      if (!adapter.credentialFields.some((field) => field.required)) {
        problems.push("At least one credential field must be required.");
      }
      for (const field of adapter.credentialFields) {
        if (!field.label?.trim()) problems.push(`The field ${field.name} has no label.`);
        if (field.pattern !== undefined) {
          try {
            new RegExp(field.pattern);
          } catch {
            problems.push(`The pattern of ${field.name} is not a regular expression.`);
          }
        }
      }
      if (!Number.isInteger(caps.batchSize) || caps.batchSize < 1) {
        problems.push("capabilities.batchSize must be a positive integer.");
      }
      if (
        caps.idempotency &&
        !(typeof caps.idempotencyWindowMs === "number" && caps.idempotencyWindowMs > 0)
      ) {
        problems.push("With idempotency, set idempotencyWindowMs to the provider's window.");
      }
      if (!caps.idempotency && caps.idempotencyWindowMs !== null) {
        problems.push("Without idempotency, idempotencyWindowMs must be null.");
      }
      if (!["recipient", "request"].includes(caps.rateUnit)) {
        problems.push(`capabilities.rateUnit is ${caps.rateUnit}.`);
      }
      for (const type of caps.eventTypes) {
        if (!PROVIDER_EVENT_TYPES.includes(type)) problems.push(`Unknown event type ${type}.`);
      }
      if (new Set(caps.eventTypes).size !== caps.eventTypes.length) {
        problems.push("capabilities.eventTypes repeats a type.");
      }
      if (typeof caps.customHeaders !== "boolean") problems.push("Set customHeaders.");
      if (caps.autoWebhook && !adapter.setupEvents) {
        problems.push("autoWebhook is true, but the adapter has no setupEvents.");
      }
      if (adapter.setupEvents && !adapter.teardownEvents) {
        problems.push("An adapter with setupEvents needs teardownEvents.");
      }
      if (!hasWebhook && caps.eventTypes.length > 0) {
        problems.push("manualSecret is none, but the adapter declares event types.");
      }
      if (hasWebhook && caps.eventTypes.length === 0) {
        problems.push("The adapter has a webhook but declares no event types.");
      }
      const facts = adapter.facts;
      if (!(Number.isFinite(facts.ratePerSecond) && facts.ratePerSecond > 0)) {
        problems.push("facts.ratePerSecond must be a positive number.");
      }
      if (typeof facts.requiresWorkersPaid !== "boolean") {
        problems.push("Set facts.requiresWorkersPaid.");
      }
      if (facts.notes.length === 0) problems.push("Add at least one note to facts.notes.");
      for (const note of facts.notes) {
        if (!/\.$/.test(note.trim())) problems.push(`The note "${note}" must be a full sentence.`);
      }
      if (!/^https:\/\//.test(facts.docsUrl)) problems.push("facts.docsUrl must be HTTPS.");
      if (adapter.dns.spfInclude !== null && typeof adapter.dns.spfInclude !== "string") {
        problems.push("dns.spfInclude must be a string or null.");
      }
      const steps = adapter.manualSteps({ url: HOOK_URL, secret: "conformance-secret" });
      if (!Array.isArray(steps) || steps.length === 0) {
        problems.push("manualSteps must return at least one step.");
      } else if (hasWebhook && !steps.some((step) => step.includes(HOOK_URL))) {
        problems.push("One of the manualSteps must show the webhook URL.");
      }
    }),

    check("policy", "declares a policy that matches its warning and headers", (problems) => {
      if (adapter.policy !== "campaign" && adapter.policy !== "transactional-only") {
        problems.push(
          `The policy ${String(adapter.policy)} is not campaign or transactional-only.`,
        );
      }
      if (adapter.policy === "transactional-only" && !adapter.policyWarning?.trim()) {
        problems.push(
          "A transactional-only adapter needs a policyWarning for the owner to accept.",
        );
      }
      if (adapter.policy === "campaign" && adapter.policyWarning !== undefined) {
        problems.push("A campaign adapter must not have a policyWarning.");
      }
      if (adapter.policy === "campaign" && !caps.customHeaders) {
        problems.push(
          "A campaign adapter must pass custom headers, so both unsubscribe headers reach the email.",
        );
      }
    }),

    check("send.all-sent", "maps an accepted batch to sent, in order", async (problems) => {
      const { messages, result } = await send(fixtures.send.allSent);
      if (!checkShape(messages, result, problems)) return;
      if (result.failure)
        problems.push(`An accepted batch has a failure: ${result.failure.reason}.`);
      result.results.forEach((item, index) => {
        if (item.outcome !== "sent") problems.push(`Result ${index} is ${item.outcome}, not sent.`);
      });
    }),

    check("send.partial", "maps a partial failure to each recipient", async (problems) => {
      const fixture = fixtures.send.partial;
      if (!fixture) return missing(problems, "send.partial", "send.partial");
      const { messages, result } = await send(fixture);
      if (fixture.expected.length !== messages.length) {
        problems.push(
          `expected has ${fixture.expected.length} entries for ${messages.length} messages.`,
        );
        return;
      }
      if (!checkShape(messages, result, problems)) return;
      fixture.expected.forEach((want, index) => {
        const item = result.results[index];
        if (item?.outcome !== want.outcome) {
          problems.push(
            `Result ${index} is ${item?.outcome}. The fixture expects ${want.outcome}.`,
          );
        }
        if (want.reason && item?.reason !== want.reason) {
          problems.push(`Result ${index} has reason ${item?.reason}, not ${want.reason}.`);
        }
      });
      const outcomes = new Set(fixture.expected.map((want) => want.outcome));
      if (!outcomes.has("sent") || outcomes.size < 2) {
        problems.push("A partial fixture needs at least one sent and one failed recipient.");
      }
    }),

    check(
      "send.headers",
      "sends both List-Unsubscribe and List-Unsubscribe-Post",
      async (problems) => {
        const { messages, calls } = await send(fixtures.send.allSent);
        const sent = calls.flatMap((call) => fixtures.emailHeaders(call));
        if (sent.length !== messages.length) {
          problems.push(
            `The requests hold ${sent.length} emails for ${messages.length} messages. Check emailHeaders.`,
          );
        }
        for (const message of messages) {
          const want = headerValue(message.headers, LIST_UNSUBSCRIBE);
          const headers = sent.find((item) => headerValue(item, LIST_UNSUBSCRIBE) === want);
          if (!headers) {
            problems.push(`The email to ${message.to} has no ${LIST_UNSUBSCRIBE}: ${want}.`);
            continue;
          }
          const post = headerValue(headers, LIST_UNSUBSCRIBE_POST);
          if (post !== ONE_CLICK_VALUE) {
            problems.push(
              `The email to ${message.to} has ${LIST_UNSUBSCRIBE_POST}: ${post ?? "(missing)"}, not ${ONE_CLICK_VALUE}.`,
            );
          }
        }
      },
      caps.customHeaders
        ? undefined
        : "customHeaders is false. The adapter cannot carry the unsubscribe headers.",
    ),

    check(
      "send.idempotency",
      "sends the idempotency key and the same payload on a retry",
      async (problems) => {
        const key = "conformance-idempotency-key-1";
        const fixture = fixtures.send.allSent;
        const exchanges = fixture.exchanges.map((exchange) => ({ ...exchange, times: undefined }));
        const first = await send(fixture, { idempotencyKey: key, exchanges });
        const second = await send(fixture, { idempotencyKey: key, exchanges });
        const calls = [...first.calls, ...second.calls];
        if (calls.length === 0) problems.push("sendBatch made no request.");
        for (const call of calls) {
          if (![...call.headers.values()].includes(key)) {
            problems.push(`The request to ${call.url} does not carry the idempotency key.`);
          }
        }
        const bodies = (list: CapturedRequest[]) => list.map((call) => call.body).sort();
        if (JSON.stringify(bodies(first.calls)) !== JSON.stringify(bodies(second.calls))) {
          problems.push("A retry with the same key must send the same payload, byte for byte.");
        }
      },
      caps.idempotency ? undefined : "capabilities.idempotency is false.",
    ),

    check(
      "send.retryable",
      "returns a throttle as not_sent with retryAfterMs",
      async (problems) => {
        const fixture = fixtures.send.retryable;
        if (!fixture) return missing(problems, "send.retryable", "send.retryable");
        await failedBatch(problems, fixture, "retryable");
      },
    ),

    check("send.permanent", "returns auth, quota, or credits as not_sent", async (problems) => {
      const fixture = fixtures.send.permanent;
      if (!fixture) return missing(problems, "send.permanent", "send.permanent");
      await failedBatch(problems, fixture, "permanent");
    }),

    check("send.uncertain", "returns a 5xx and a timeout as unknown", async (problems) => {
      const fixture = fixtures.send.uncertain;
      if (!fixture) return missing(problems, "send.uncertain", "send.uncertain");
      const runs = [
        { label: "5xx", run: await send(fixture) },
        {
          label: "timeout",
          run: await send(fixture, {
            fetch: throwingFetch(
              () => new DOMException("The operation timed out.", "TimeoutError"),
            ),
          }),
        },
      ];
      for (const { label, run } of runs) {
        if (!checkShape(run.messages, run.result, problems)) return;
        run.result.results.forEach((item, index) => {
          if (item.outcome !== "unknown") {
            problems.push(`After a ${label}, result ${index} is ${item.outcome}, not unknown.`);
          }
        });
        if (run.result.failure && run.result.failure.outcome !== "unknown") {
          problems.push(`After a ${label}, failure.outcome must be unknown.`);
        }
      }
    }),

    check(
      "webhook.valid",
      hasWebhook ? "accepts a valid webhook" : "rejects every request (the adapter has no webhook)",
      async (problems) => {
        if (!hasWebhook) {
          // Without a webhook, nothing may pass.
          const result = await verify(strangerRequest(), "conformance-secret");
          if (result.ok) problems.push("An adapter without a webhook must reject every request.");
          return;
        }
        if (!fixtures.webhook) return missing(problems, "webhook.valid", "webhook");
        await validFirst(problems);
      },
    ),

    check(
      "webhook.changed",
      "rejects a changed payload",
      async (problems) => {
        const webhook = fixtures.webhook;
        if (!webhook) return missing(problems, "webhook.changed", "webhook");
        const request = await validFirst(problems);
        if (!request) return;
        const changed = (webhook.tamper ?? defaultTamper)(cloneRequest(request));
        if (changed.body === request.body) {
          problems.push("tamper did not change the body.");
          return;
        }
        const result = await verify(changed, webhook.secret);
        if (result.ok) problems.push("verifyWebhook accepted a changed payload.");
      },
      noWebhook,
    ),

    check(
      "webhook.wrong-secret",
      "rejects a wrong secret",
      async (problems) => {
        const webhook = fixtures.webhook;
        if (!webhook) return missing(problems, "webhook.wrong-secret", "webhook");
        const request = await validFirst(problems);
        if (!request) return;
        const wrong = webhook.wrongSecret ?? randomSecret();
        if (wrong === webhook.secret) problems.push("wrongSecret is the same as secret.");
        const result = await verify(cloneRequest(request), wrong);
        if (result.ok) problems.push("verifyWebhook accepted a wrong secret.");
        const empty = await verify(cloneRequest(request), "");
        if (empty.ok) problems.push("verifyWebhook accepted an empty secret.");
      },
      noWebhook,
    ),

    check(
      "webhook.stale",
      "rejects a stale timestamp",
      async (problems) => {
        const webhook = fixtures.webhook;
        if (!webhook?.stale) return missing(problems, "webhook.stale", "webhook.stale");
        if (!(await validFirst(problems))) return;
        const result = await verify(await webhook.stale(), webhook.secret);
        if (result.ok) problems.push("verifyWebhook accepted a stale timestamp.");
      },
      noWebhook,
    ),

    check("events.parse", "normalizes events to the contract's types", async (problems) => {
      if (!hasWebhook) {
        const parsed = adapter.parseEvents(strangerRequest());
        if (parsed.events.length > 0) {
          problems.push("An adapter without a webhook must return no events.");
        }
        return;
      }
      const list = fixtures.events ?? [];
      if (list.length === 0) return missing(problems, "events.parse", "events");
      const seen = new Set<string>();
      for (const fixture of list) {
        const request = await fixture.request();
        const parsed = adapter.parseEvents(cloneRequest(request));
        const again = adapter.parseEvents(cloneRequest(request));
        const where = `"${fixture.label}"`;
        if (parsed.events.length !== fixture.expected.length) {
          problems.push(
            `${where} gave ${parsed.events.length} events. The fixture expects ${fixture.expected.length}.`,
          );
          continue;
        }
        parsed.events.forEach((event, index) => {
          seen.add(event.type);
          if (!caps.eventTypes.includes(event.type)) {
            problems.push(
              `${where} gave ${event.type}, which capabilities.eventTypes does not list.`,
            );
          }
          if (typeof event.eventId !== "string" || event.eventId.length === 0) {
            problems.push(`${where} gave an event without an eventId.`);
          }
          if (again.events[index]?.eventId !== event.eventId) {
            problems.push(`${where}: the eventId changes between two parses of one body.`);
          }
          if (!Number.isFinite(event.occurredAt)) {
            problems.push(`${where} gave an event without a valid occurredAt.`);
          }
          const want = fixture.expected[index] ?? { type: event.type };
          for (const [field, value] of Object.entries(want)) {
            const actual = (event as unknown as Record<string, unknown>)[field];
            if (actual !== value) {
              problems.push(`${where}: ${field} is ${String(actual)}, not ${String(value)}.`);
            }
          }
        });
        const ids = parsed.events.map((event) => event.eventId);
        if (new Set(ids).size !== ids.length) problems.push(`${where} repeats an eventId.`);
      }
      for (const type of caps.eventTypes) {
        if (!seen.has(type)) problems.push(`No event fixture gives ${type}. Add one.`);
      }
    }),

    check("connect.ok", "connects with a good key", async (problems) => {
      const mock = mockFetch(fixtures.connect.ok);
      const result = await adapter.connect(fixtures.credentials, context(mock.fetch));
      if (!result.ok) {
        problems.push(`connect failed: ${result.reason}, ${result.message}`);
        return;
      }
      if (!Array.isArray(result.warnings)) problems.push("connect must return a warnings array.");
      for (const [key, value] of Object.entries(result.refs ?? {})) {
        if (typeof value !== "string") problems.push(`The ref ${key} is not a string.`);
      }
    }),

    check("connect.bad-key", "rejects a bad key", async (problems) => {
      const mock = mockFetch(fixtures.connect.badKey);
      const result = await adapter.connect(fixtures.credentials, context(mock.fetch));
      const want = fixtures.connect.badKeyReason ?? "auth";
      if (result.ok) problems.push("connect accepted a bad key.");
      else if (result.reason !== want)
        problems.push(`The reason is ${result.reason}, not ${want}.`);
      if (!result.ok && !result.message?.trim()) problems.push("Give the owner a message.");
    }),

    check(
      "connect.server-error",
      "reports a provider 5xx and a network error",
      async (problems) => {
        // The same requests as `connect.ok`, answered with 503.
        const down = fixtures.connect.ok.map((exchange) => ({
          ...exchange,
          times: undefined,
          response: { status: 503, body: { message: "Service unavailable." } },
        }));
        const server = await adapter.connect(fixtures.credentials, context(mockFetch(down).fetch));
        if (server.ok) problems.push("connect passed while the provider returned 503.");
        else if (server.reason !== "server_error") {
          problems.push(`After a 503, the reason is ${server.reason}, not server_error.`);
        }
        const offline = await adapter.connect(
          fixtures.credentials,
          context(throwingFetch(() => new TypeError("Network connection lost."))),
        );
        if (offline.ok) problems.push("connect passed without a network.");
        else if (offline.reason !== "network") {
          problems.push(`Without a network, the reason is ${offline.reason}, not network.`);
        }
      },
    ),
  ];
}

/** Runs every check and returns the results. The kit's own tests use it. */
export async function runChecks(
  adapter: ProviderAdapter,
  fixtures: ConformanceFixtures,
): Promise<CheckReport[]> {
  const reports: CheckReport[] = [];
  for (const item of conformanceChecks(adapter, fixtures)) {
    reports.push({ id: item.id, title: item.title, ...(await item.run()) });
  }
  return reports;
}
