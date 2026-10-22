import type {
  Credentials,
  FailureReason,
  NormalizedEvent,
  ProviderRefs,
  SendOutcome,
  WebhookRequest,
} from "../../src/types";
import type { CapturedRequest, RecordedExchange } from "../mock-fetch";
import type { MockSmtpOptions } from "../mock-smtp";

// The fixture format of the conformance kit (U18). A contributor records real provider
// exchanges once, puts them in this shape, and passes them to `runConformance`. The kit
// sends the sample messages of `messages.ts`, so a batch of `size` holds recipients
// r1, r2, and so on, with the addresses student1@example.org, student2@example.org.
//
// An SMTP adapter has no HTTP exchanges. Its fixtures set `smtp` (the behavior of the
// in-process mock server of mock-smtp.ts) where an HTTP adapter sets `exchanges`. The
// kit then passes the mock's `connect` and a fetch that fails, and `emailHeaders` gets
// one captured request per accepted message, with the message source as the body.

/** The ids of the checks. `skip` in the fixtures takes the same ids. */
export type CheckId =
  | "declaration"
  | "policy"
  | "send.all-sent"
  | "send.partial"
  | "send.headers"
  | "send.idempotency"
  | "send.retryable"
  | "send.permanent"
  | "send.uncertain"
  | "webhook.valid"
  | "webhook.changed"
  | "webhook.wrong-secret"
  | "webhook.stale"
  | "events.parse"
  | "connect.ok"
  | "connect.bad-key"
  | "connect.server-error";

/** Recorded exchanges for one batch send. */
export interface SendFixture {
  /** The number of sample messages in the batch. Defaults to 2. */
  size?: number;
  /**
   * The provider answers. Leave `times` out when the adapter sends one request per
   * recipient, or when the kit sends the batch twice (the idempotency check).
   */
  exchanges?: RecordedExchange[];
  /** For an SMTP adapter: how the mock SMTP server answers, in place of `exchanges`. */
  smtp?: MockSmtpOptions;
}

/** A batch where some recipients pass and some fail, for example a 207 response. */
export interface PartialSendFixture extends SendFixture {
  /** The result of each recipient, in batch order. */
  expected: { outcome: SendOutcome; reason?: FailureReason }[];
}

/** A batch that fails as a whole. */
export interface FailedSendFixture extends SendFixture {
  /** The `failure.reason` that the adapter must return. */
  reason: FailureReason;
  /** The `failure.retryAfterMs` that the adapter must return, from `Retry-After`. */
  retryAfterMs?: number;
}

export interface WebhookFixture {
  /** The secret that the provider used to sign `valid`. */
  secret: string;
  /** A secret that must fail. Defaults to a random secret. */
  wrongSecret?: string;
  /** Refs for the verify call, when they differ from `ConformanceFixtures.refs`. */
  refs?: ProviderRefs;
  /** Exchanges that verification needs, for example the SNS signing certificate. */
  exchanges?: RecordedExchange[];
  /** A request that the provider signed with `secret`, at `ConformanceFixtures.now`. */
  valid(): WebhookRequest | Promise<WebhookRequest>;
  /**
   * Changes the content of a valid request, but keeps its signature. The default
   * changes the first string value in the JSON body. Give your own when the signature
   * covers parsed fields and not the raw bytes.
   */
  tamper?(request: WebhookRequest): WebhookRequest;
  /** A request signed with a timestamp outside the provider's window. */
  stale?(): WebhookRequest | Promise<WebhookRequest>;
}

/** One webhook body and the events that `parseEvents` must return for it. */
export interface EventFixture {
  label: string;
  request(): WebhookRequest | Promise<WebhookRequest>;
  /**
   * The events, in order. Each entry lists the fields to compare. An empty list means
   * the adapter must skip the body, for example an open event or an auto-reply.
   */
  expected: (Pick<NormalizedEvent, "type"> & Partial<NormalizedEvent>)[];
}

export interface ConformanceFixtures {
  credentials: Credentials;
  /** Refs for every call, as `connect` and `setupEvents` would return them. */
  refs?: ProviderRefs;
  /** The clock of every call, in Unix milliseconds. Defaults to the real clock. */
  now?: number;
  /** For an SMTP adapter: the reply timeout of every call, in milliseconds. Defaults to 500. */
  smtpTimeoutMs?: number;
  /**
   * Reads the headers of each email in one captured request. Return one record per
   * email: one record for a per-recipient API, several for a batch API.
   */
  emailHeaders(request: CapturedRequest): Record<string, string>[];

  send: {
    /** Every recipient accepted. The header and idempotency checks reuse it. */
    allSent: SendFixture;
    partial?: PartialSendFixture;
    /** A throttle, usually 429 with `Retry-After`. The outcome must be `not_sent`. */
    retryable?: FailedSendFixture;
    /** A failure that a retry does not fix: auth, quota, or credits. */
    permanent?: FailedSendFixture;
    /** A 5xx. Every recipient must be `unknown`. */
    uncertain?: SendFixture;
  };

  connect: {
    /** A good key. `connect` must return `ok: true`. */
    ok: RecordedExchange[];
    /**
     * A wrong key. `connect` must return `ok: false`. The kit also answers the `ok`
     * requests with 503 and with a network error, so 5xx needs no fixture.
     */
    badKey: RecordedExchange[];
    /** The reason for a wrong key. Defaults to `auth`. */
    badKeyReason?: FailureReason;
    /**
     * For an SMTP adapter: the mock server for a good and a wrong login. The kit uses
     * them in place of `ok` and `badKey`, and checks a 421 greeting and a failed connect
     * in place of the 503 and the network error.
     */
    smtp?: { ok: MockSmtpOptions; badKey: MockSmtpOptions };
  };

  /** Leave out for an adapter without webhooks (`manualSecret: "none"`). */
  webhook?: WebhookFixture;
  /** Bodies for `parseEvents`. Together they must cover every declared event type. */
  events?: EventFixture[];

  /**
   * Checks that do not apply, with the reason. The suite shows each one as skipped.
   * A check without its fixture and without a reason here fails.
   */
  skip?: Partial<Record<CheckId, string>>;
}
