import { AwsClient } from "aws4fetch";
import { timingSafeEqual } from "../shared/encoding";
import { callProvider, type HttpCall, readJson, retryAfterMs, shortMessage } from "../shared/http";
import type {
  AdapterContext,
  BatchFailure,
  ConnectionCheck,
  Credentials,
  DnsRecordHint,
  EventsSetup,
  FailureReason,
  OutgoingMessage,
  ProviderAdapter,
  RecipientResult,
  SendBatchResult,
  SendOutcome,
} from "../types";
import { parseSesWebhook } from "./events";
import { parseSnsMessage, topicRegion, verifySnsSignature } from "./sns-verify";

// Amazon SES through the v2 API, signed with SigV4 by aws4fetch (KTD16).
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/
//
// SendBulkEmail takes only templates, and its "simple substitution" of a whole HTML
// body is not documented. So each recipient gets one SendEmail call, with the
// unsubscribe headers in `Content.Simple.Headers`. A batch of 25 stays inside the
// subrequest budget of Workers Free (KTD20).

const BATCH_SIZE = 25;
const CONCURRENCY = 5;
/** The SES default for a new account. GetAccount reports the real `MaxSendRate`. */
const DEFAULT_RATE = 1;

interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

function sesCredentials(credentials: Credentials): SesCredentials {
  return {
    accessKeyId: credentials.accessKeyId ?? "",
    secretAccessKey: credentials.secretAccessKey ?? "",
    region: credentials.region ?? "",
  };
}

function client(credentials: Credentials, service: "ses" | "sns"): AwsClient {
  const { accessKeyId, secretAccessKey, region } = sesCredentials(credentials);
  return new AwsClient({ accessKeyId, secretAccessKey, region, service, retries: 0 });
}

function sesUrl(credentials: Credentials, path: string): string {
  return `https://email.${sesCredentials(credentials).region}.amazonaws.com${path}`;
}

function snsUrl(credentials: Credentials): string {
  return `https://sns.${sesCredentials(credentials).region}.amazonaws.com/`;
}

async function sesCall(
  ctx: AdapterContext,
  credentials: Credentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpCall> {
  const request = await client(credentials, "ses").sign(sesUrl(credentials, path), {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return callProvider(ctx, request);
}

/** An SNS Query API call. The response is XML. */
async function snsCall(
  ctx: AdapterContext,
  credentials: Credentials,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const request = await client(credentials, "sns").sign(snsUrl(credentials), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, Version: "2010-03-31" }).toString(),
  });
  const call = await callProvider(ctx, request);
  if (!call.ok) return { ok: false, status: 0, text: call.message };
  return { ok: call.response.ok, status: call.response.status, text: await call.response.text() };
}

function xmlValue(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1] ?? null;
}

/** The SES error name, from `x-amzn-ErrorType` or the body. */
async function sesError(response: Response): Promise<{ code: string; message: string }> {
  const header = response.headers.get("x-amzn-errortype") ?? "";
  const body = (await readJson(response)) as Record<string, unknown> | null;
  const rawCode = header || String(body?.__type ?? body?.code ?? "");
  const code = rawCode.split(":")[0]?.split("#").pop() ?? "";
  const message = shortMessage(body?.message ?? body?.Message, `SES returned ${response.status}.`);
  return { code, message };
}

interface Classified {
  outcome: SendOutcome;
  reason: FailureReason;
  /** The error is about the account, so the rest of the batch fails the same way. */
  stop: boolean;
}

/** Maps an SES error to the classes of KTD12. */
export function classifySesError(status: number, code: string, message: string): Classified {
  if (status >= 500) return { outcome: "unknown", reason: "server_error", stop: false };
  if (/daily message quota|maximum sending quota/i.test(message)) {
    return { outcome: "not_sent", reason: "quota", stop: true };
  }
  switch (code) {
    case "TooManyRequestsException":
    case "ThrottlingException":
      return { outcome: "not_sent", reason: "rate_limited", stop: true };
    case "LimitExceededException":
      return { outcome: "not_sent", reason: "quota", stop: true };
    case "AccountSuspendedException":
    case "SendingPausedException":
    case "AccessDeniedException":
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "SignatureDoesNotMatch":
      return { outcome: "not_sent", reason: "auth", stop: true };
    case "MailFromDomainNotVerifiedException":
    case "NotFoundException":
      return { outcome: "not_sent", reason: "validation", stop: true };
    case "MessageRejected":
      return { outcome: "not_sent", reason: "rejected", stop: false };
    default:
      if (status === 429) return { outcome: "not_sent", reason: "rate_limited", stop: true };
      if (status === 401 || status === 403)
        return { outcome: "not_sent", reason: "auth", stop: true };
      return { outcome: "not_sent", reason: "validation", stop: false };
  }
}

function sendEmailBody(message: OutgoingMessage, configurationSet: string | undefined) {
  return {
    FromEmailAddress: message.from,
    Destination: { ToAddresses: [message.to] },
    ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: message.html, Charset: "UTF-8" },
          ...(message.text ? { Text: { Data: message.text, Charset: "UTF-8" } } : {}),
        },
        Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
      },
    },
  };
}

async function sendOne(
  message: OutgoingMessage,
  credentials: Credentials,
  ctx: AdapterContext,
): Promise<{ result: RecipientResult; failure?: BatchFailure; stop: boolean }> {
  const call = await sesCall(
    ctx,
    credentials,
    "POST",
    "/v2/email/outbound-emails",
    sendEmailBody(message, ctx.refs.configurationSet),
  );
  if (!call.ok) {
    return {
      result: {
        recipientId: message.recipientId,
        outcome: "unknown",
        reason: call.reason,
        message: call.message,
      },
      stop: false,
    };
  }
  const { response } = call;
  if (response.ok) {
    const body = (await readJson(response)) as { MessageId?: string } | null;
    return {
      result: {
        recipientId: message.recipientId,
        outcome: "sent",
        ...(body?.MessageId ? { providerMessageId: body.MessageId } : {}),
      },
      stop: false,
    };
  }
  const error = await sesError(response);
  const classified = classifySesError(response.status, error.code, error.message);
  const failure: BatchFailure | undefined = classified.stop
    ? {
        outcome: "not_sent",
        reason: classified.reason,
        message: error.message,
        status: response.status,
        ...(retryAfterMs(response) === undefined ? {} : { retryAfterMs: retryAfterMs(response) }),
      }
    : undefined;
  return {
    result: {
      recipientId: message.recipientId,
      outcome: classified.outcome,
      reason: classified.reason,
      message: error.message,
    },
    ...(failure ? { failure } : {}),
    stop: classified.stop,
  };
}

async function sendBatch(
  messages: readonly OutgoingMessage[],
  credentials: Credentials,
  ctx: AdapterContext,
): Promise<SendBatchResult> {
  const results: (RecipientResult | undefined)[] = new Array(messages.length);
  let failure: BatchFailure | undefined;
  let next = 0;
  // A small pool. After an account-level error (throttle, quota, auth), the messages
  // that did not start are not sent, so a retry cannot duplicate them.
  async function worker() {
    while (next < messages.length) {
      const index = next++;
      const message = messages[index] as OutgoingMessage;
      if (failure) {
        results[index] = {
          recipientId: message.recipientId,
          outcome: "not_sent",
          reason: failure.reason,
          message: failure.message,
        };
        continue;
      }
      const sent = await sendOne(message, credentials, ctx);
      results[index] = sent.result;
      if (sent.failure && !failure) failure = sent.failure;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker));
  const done = results as RecipientResult[];
  return failure ? { results: done, failure } : { results: done };
}

async function connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck> {
  const call = await sesCall(ctx, credentials, "GET", "/v2/email/account");
  if (!call.ok) return { ok: false, reason: call.reason, message: call.message };
  const { response } = call;
  if (!response.ok) {
    const error = await sesError(response);
    const classified = classifySesError(response.status, error.code, error.message);
    const message =
      classified.reason === "auth"
        ? "AWS rejected the access key. Check the key, the secret, and the region."
        : error.message;
    return { ok: false, reason: classified.reason, message };
  }
  const account = (await readJson(response)) as {
    ProductionAccessEnabled?: boolean;
    SendingEnabled?: boolean;
    SendQuota?: { Max24HourSend?: number; MaxSendRate?: number };
  } | null;
  const { region } = sesCredentials(credentials);
  const warnings: string[] = [];
  if (account?.ProductionAccessEnabled === false) {
    warnings.push(
      "The account is in the SES sandbox. It can send only to verified addresses until AWS grants production access.",
    );
  }
  if (account?.SendingEnabled === false) warnings.push("Sending is paused for this SES account.");
  const rate = account?.SendQuota?.MaxSendRate;
  const daily = account?.SendQuota?.Max24HourSend;
  return {
    ok: true,
    account: `${region}, ${account?.ProductionAccessEnabled ? "production access" : "sandbox"}`,
    warnings,
    refs: {
      region,
      ...(rate ? { maxSendRate: String(rate) } : {}),
      ...(daily ? { max24HourSend: String(daily) } : {}),
    },
  };
}

/** A configuration set name for one connection: letters, digits, and dashes, at most 64. */
function configurationSetName(secret: string): string {
  return `envelopen-${secret
    .replaceAll(/[^A-Za-z0-9]/g, "")
    .slice(0, 16)
    .toLowerCase()}`;
}

async function isAlreadyExists(call: HttpCall): Promise<boolean> {
  if (!call.ok || call.response.ok) return false;
  return (await sesError(call.response)).code === "AlreadyExistsException";
}

const NO_PERMISSION =
  "The IAM user cannot create the configuration set, the SNS topic, or the subscription. Follow the manual steps, or add those permissions and try again.";

/**
 * KTD13: a configuration set, an SNS topic with SignatureVersion 2, an HTTPS
 * subscription to the webhook URL, and an event destination. Any missing permission
 * falls back to manual steps. Envelopen confirms the subscription when SNS calls.
 */
async function setupEvents(
  credentials: Credentials,
  target: { url: string; secret: string },
  ctx: AdapterContext,
): Promise<EventsSetup> {
  const name = configurationSetName(target.secret);
  const created = await sesCall(ctx, credentials, "POST", "/v2/email/configuration-sets", {
    ConfigurationSetName: name,
  });
  if (!created.ok || (!created.response.ok && !(await isAlreadyExists(created)))) {
    return { mode: "manual", reason: NO_PERMISSION };
  }

  const topic = await snsCall(ctx, credentials, { Action: "CreateTopic", Name: name });
  const topicArn = topic.ok ? xmlValue(topic.text, "TopicArn") : null;
  if (!topicArn) return { mode: "manual", reason: NO_PERMISSION };
  const signature = await snsCall(ctx, credentials, {
    Action: "SetTopicAttributes",
    TopicArn: topicArn,
    AttributeName: "SignatureVersion",
    AttributeValue: "2",
  });
  if (!signature.ok) return { mode: "manual", reason: NO_PERMISSION };
  const subscription = await snsCall(ctx, credentials, {
    Action: "Subscribe",
    TopicArn: topicArn,
    Protocol: "https",
    Endpoint: target.url,
  });
  if (!subscription.ok) return { mode: "manual", reason: NO_PERMISSION };

  const destination = await sesCall(
    ctx,
    credentials,
    "POST",
    `/v2/email/configuration-sets/${name}/event-destinations`,
    {
      EventDestinationName: "envelopen-sns",
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ["DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE"],
        SnsDestination: { TopicArn: topicArn },
      },
    },
  );
  if (!destination.ok || (!destination.response.ok && !(await isAlreadyExists(destination)))) {
    return { mode: "manual", reason: NO_PERMISSION };
  }
  return {
    mode: "auto",
    secret: target.secret,
    refs: { configurationSet: name, topicArn },
  };
}

async function teardownEvents(credentials: Credentials, ctx: AdapterContext): Promise<void> {
  const { configurationSet, topicArn } = ctx.refs;
  // Deleting the configuration set also deletes its event destinations.
  if (configurationSet) {
    await sesCall(ctx, credentials, "DELETE", `/v2/email/configuration-sets/${configurationSet}`);
  }
  if (topicArn) await snsCall(ctx, credentials, { Action: "DeleteTopic", TopicArn: topicArn });
}

/** The DKIM CNAME records from GetEmailIdentity, or null when the domain is not in SES. */
async function domainRecords(
  credentials: Credentials,
  domain: string,
  ctx: AdapterContext,
): Promise<DnsRecordHint[] | null> {
  const call = await sesCall(
    ctx,
    credentials,
    "GET",
    `/v2/email/identities/${encodeURIComponent(domain)}`,
  );
  if (!call.ok || !call.response.ok) return null;
  const identity = (await readJson(call.response)) as {
    DkimAttributes?: { Tokens?: string[] };
  } | null;
  const tokens = identity?.DkimAttributes?.Tokens ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => ({
    purpose: "dkim",
    type: "CNAME",
    host: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
  }));
}

export const sesAdapter: ProviderAdapter = {
  id: "ses",
  name: "Amazon SES",
  policy: "campaign",
  credentialFields: [
    {
      name: "accessKeyId",
      label: "Access key ID",
      secret: false,
      required: true,
      placeholder: "AKIA...",
      pattern: "^[A-Z0-9]{16,128}$",
      hint: "An IAM user with ses:SendEmail and ses:GetAccount. Add SNS and configuration set permissions for automatic event setup.",
    },
    {
      name: "secretAccessKey",
      label: "Secret access key",
      secret: true,
      required: true,
    },
    {
      name: "region",
      label: "Region",
      secret: false,
      required: true,
      placeholder: "us-east-1",
      pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$",
    },
  ],
  capabilities: {
    batchSize: BATCH_SIZE,
    idempotency: false,
    idempotencyWindowMs: null,
    rateUnit: "recipient",
    eventTypes: ["delivered", "bounce_hard", "bounce_soft", "complaint", "failed"],
    customHeaders: true,
    autoWebhook: true,
  },
  facts: {
    ratePerSecond: DEFAULT_RATE,
    requiresWorkersPaid: false,
    notes: [
      "New accounts start in the sandbox: 200 emails per 24 hours, 1 per second, verified recipients only.",
      "Request production access with the Marketing use case before the first campaign.",
      "SES has no idempotency key, so a batch that times out becomes uncertain and waits for your decision.",
    ],
    docsUrl: "https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html",
  },
  dns: { spfInclude: "amazonses.com", dkimSelectors: [] },

  manualSecret: "envelopen",

  connect,
  sendBatch,
  setupEvents,
  teardownEvents,
  domainRecords,

  // The token is the last path segment, not a query parameter: request logs often keep
  // the query string. URLs of connections from before still carry `?token=`, and
  // verifyWebhook accepts both.
  webhookUrl(baseUrl, secret) {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(secret)}`;
    return url.toString();
  },

  async verifyWebhook(request, secret, ctx) {
    // Anyone can subscribe this URL to their own SNS topic, and SNS would sign those
    // messages too. So the URL token must match, and the topic must be ours.
    const token = webhookToken(request.url);
    if (!secret || !timingSafeEqual(token, secret)) return { ok: false, reason: "Wrong token." };
    const message = parseSnsMessage(request.body);
    if (!message) return { ok: false, reason: "Not an SNS message." };
    if (ctx.refs.topicArn && message.TopicArn !== ctx.refs.topicArn) {
      return { ok: false, reason: "The topic is not the topic of this connection." };
    }
    const region = ctx.refs.region ?? topicRegion(message.TopicArn) ?? "";
    return verifySnsSignature(message, region, ctx.fetch);
  },

  parseEvents(request) {
    return parseSesWebhook(request.body);
  },

  manualSteps(target) {
    return [
      "In the SES console, open Configuration sets and create a set named envelopen.",
      "In the SNS console, create a Standard topic. Under Message signature, choose SignatureVersion 2 (SHA256).",
      `Create an HTTPS subscription on the topic with this endpoint: ${target.url}`,
      "Envelopen confirms the subscription by itself within a minute.",
      "In the configuration set, add an event destination of type SNS for Deliveries, Hard bounces, Complaints, Rejects, and Rendering failures, with the topic.",
      "Open your verified domain identity in SES and set envelopen as its default configuration set.",
    ];
  },
};

/** The URL token: `?token=` on URLs from before, else the last path segment. */
function webhookToken(requestUrl: string): string {
  const url = new URL(requestUrl);
  const query = url.searchParams.get("token");
  if (query !== null) return query;
  try {
    return decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  } catch {
    return "";
  }
}

export { configurationSetName };
