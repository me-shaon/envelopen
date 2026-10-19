import { clearSnsKeyCache } from "../../src/ses/sns-verify";
import type { RecordedExchange, RecordedResponse } from "../mock-fetch";
import { createSnsSigner, type SnsSigner } from "../sns-signer";
import type { ConformanceFixtures } from "./types";

// Amazon SES v2 and SNS exchanges, in the shapes of the AWS API references (checked
// 2026-10-19). Ids are made up.

const REGION = "us-east-1";
const SES = `https://email.${REGION}.amazonaws.com`;
const SNS = `https://sns.${REGION}.amazonaws.com/`;

export const TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:envelopen-abc`;

export const sesFixtures = {
  region: REGION,
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: REGION,
  },
  sendOk: (messageId: string) => ({
    label: "SendEmail accepted",
    method: "POST",
    url: `${SES}/v2/email/outbound-emails`,
    times: 1,
    response: { status: 200, body: { MessageId: messageId } },
  }),
  sendRejected: {
    label: "SendEmail rejected: sandbox recipient not verified",
    method: "POST",
    url: `${SES}/v2/email/outbound-emails`,
    times: 1,
    response: {
      status: 400,
      headers: {
        "x-amzn-errortype": "MessageRejected:http://internal.amazon.com/coral/com.amazon.ses/",
      },
      body: { message: "Email address is not verified." },
    },
  },
  sendThrottled: {
    label: "SendEmail throttled",
    method: "POST",
    url: `${SES}/v2/email/outbound-emails`,
    times: 1,
    response: {
      status: 429,
      headers: { "x-amzn-errortype": "TooManyRequestsException" },
      body: { message: "Maximum sending rate exceeded." },
    },
  },
  sendServerError: {
    label: "SendEmail 503",
    method: "POST",
    url: `${SES}/v2/email/outbound-emails`,
    times: 1,
    response: { status: 503, body: { message: "Service unavailable." } },
  },
  accountProduction: {
    label: "GetAccount with production access",
    method: "GET",
    url: `${SES}/v2/email/account`,
    response: {
      status: 200,
      body: {
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 0 },
        EnforcementStatus: "HEALTHY",
      },
    },
  },
  accountSandbox: {
    label: "GetAccount in the sandbox",
    method: "GET",
    url: `${SES}/v2/email/account`,
    response: {
      status: 200,
      body: {
        ProductionAccessEnabled: false,
        SendingEnabled: true,
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 },
      },
    },
  },
  accountForbidden: {
    label: "GetAccount with a wrong key",
    method: "GET",
    url: `${SES}/v2/email/account`,
    response: {
      status: 403,
      headers: { "x-amzn-errortype": "UnrecognizedClientException" },
      body: { message: "The security token included in the request is invalid." },
    },
  },
  createConfigurationSet: {
    label: "CreateConfigurationSet",
    method: "POST",
    url: `${SES}/v2/email/configuration-sets`,
    response: { status: 200, body: {} },
  },
  createConfigurationSetDenied: {
    label: "CreateConfigurationSet without permission",
    method: "POST",
    url: `${SES}/v2/email/configuration-sets`,
    response: {
      status: 403,
      headers: { "x-amzn-errortype": "AccessDeniedException" },
      body: { message: "User is not authorized to perform ses:CreateConfigurationSet" },
    },
  },
  createEventDestination: {
    label: "CreateConfigurationSetEventDestination",
    method: "POST",
    url: /^https:\/\/email\.us-east-1\.amazonaws\.com\/v2\/email\/configuration-sets\/[^/]+\/event-destinations$/,
    response: { status: 200, body: {} },
  },
  sns: (respond: (action: string) => { status: number; body: string }) => ({
    label: "SNS Query API",
    method: "POST",
    url: SNS,
    response: (request: { body: string }) =>
      respond(new URLSearchParams(request.body).get("Action") ?? ""),
  }),
  createTopicXml: `<CreateTopicResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><CreateTopicResult><TopicArn>${TOPIC_ARN}</TopicArn></CreateTopicResult></CreateTopicResponse>`,
  subscribeXml:
    '<SubscribeResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><SubscribeResult><SubscriptionArn>pending confirmation</SubscriptionArn></SubscribeResult></SubscribeResponse>',
  identity: {
    label: "GetEmailIdentity",
    method: "GET",
    url: `${SES}/v2/email/identities/mail.example.com`,
    response: {
      status: 200,
      body: { DkimAttributes: { Tokens: ["tok1", "tok2", "tok3"], Status: "PENDING" } },
    },
  },

  /** SES event JSON, the `Message` of an SNS notification. */
  bounceEvent: JSON.stringify({
    eventType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "student1@example.org" }],
      timestamp: "2026-10-19T12:00:00.000Z",
      feedbackId: "0100017",
    },
    mail: {
      timestamp: "2026-10-19T11:59:00.000Z",
      messageId: "0100018a-ses-message-id",
      destination: ["student1@example.org"],
    },
  }),
  complaintEvent: JSON.stringify({
    eventType: "Complaint",
    complaint: {
      complainedRecipients: [{ emailAddress: "student2@example.org" }],
      timestamp: "2026-10-19T12:00:00.000Z",
      complaintFeedbackType: "abuse",
    },
    mail: { messageId: "0100018a-ses-message-2", destination: ["student2@example.org"] },
  }),
  deliveryEvent: JSON.stringify({
    eventType: "Delivery",
    delivery: { timestamp: "2026-10-19T12:00:01.000Z", recipients: ["student3@example.org"] },
    mail: { messageId: "0100018a-ses-message-3", destination: ["student3@example.org"] },
  }),
};

const SEND_URL = `${SES}/v2/email/outbound-emails`;
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-conformance.pem`;
const HOOK_TOKEN = "ses-url-token-0123456789";

/** A SendEmail exchange that answers each request by its recipient. */
function sendBy(label: string, answer: (to: string) => RecordedResponse): RecordedExchange {
  return {
    label,
    method: "POST",
    url: SEND_URL,
    response: (request) =>
      answer(
        (JSON.parse(request.body) as { Destination: { ToAddresses: string[] } }).Destination
          .ToAddresses[0] ?? "",
      ),
  };
}

const ACCEPTED = (to: string): RecordedResponse => ({
  status: 200,
  body: { MessageId: `0100018a-${to.split("@")[0]}` },
});

/** An SNS notification around an SES event. `parseEvents` does not check the signature. */
function snsBody(sesEvent: string, messageId: string, signature = "unsigned") {
  return JSON.stringify({
    Type: "Notification",
    MessageId: messageId,
    TopicArn: TOPIC_ARN,
    Message: sesEvent,
    Timestamp: "2026-10-19T12:00:02.000Z",
    SignatureVersion: "2",
    Signature: signature,
    SigningCertURL: CERT_URL,
  });
}

function hook(body: string) {
  return {
    url: `https://envelopen.test/hooks/ses/1/2?token=${HOOK_TOKEN}`,
    method: "POST",
    headers: new Headers({ "x-amz-sns-message-type": "Notification" }),
    body,
  };
}

let signer: Promise<SnsSigner> | undefined;
/** The certificate of the signer, served at `CERT_URL` once `signedHook` ran. */
let certificatePem = "";

/** A notification signed by the test SNS key, with a fresh certificate cache. */
async function signedHook(sesEvent: string) {
  signer ??= createSnsSigner();
  // Another test may have cached a different key for the same certificate URL.
  clearSnsKeyCache();
  const ready = await signer;
  certificatePem = ready.certificatePem;
  const message = await ready.sign({
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC_ARN,
    Message: sesEvent,
    Timestamp: "2026-10-19T12:00:02.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
  });
  return hook(JSON.stringify(message));
}

/** The conformance fixtures of the Amazon SES adapter (U18). */
export const sesConformance: ConformanceFixtures = {
  credentials: sesFixtures.credentials,
  refs: { region: REGION, topicArn: TOPIC_ARN, configurationSet: "envelopen-conformance" },
  // One SendEmail per recipient, with the headers as a list of names and values.
  emailHeaders: (request) => {
    const body = JSON.parse(request.body) as {
      Content: { Simple: { Headers: { Name: string; Value: string }[] } };
    };
    return [Object.fromEntries(body.Content.Simple.Headers.map((item) => [item.Name, item.Value]))];
  },
  send: {
    allSent: { exchanges: [sendBy("SendEmail accepted", ACCEPTED)] },
    partial: {
      size: 3,
      exchanges: [
        sendBy("the second recipient is rejected", (to) =>
          to === "student2@example.org"
            ? (sesFixtures.sendRejected.response as RecordedResponse)
            : ACCEPTED(to),
        ),
      ],
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "rejected" },
        { outcome: "sent" },
      ],
    },
    retryable: {
      exchanges: [
        {
          ...sesFixtures.sendThrottled,
          times: undefined,
          response: {
            ...sesFixtures.sendThrottled.response,
            headers: { ...sesFixtures.sendThrottled.response.headers, "retry-after": "1" },
          },
        },
      ],
      reason: "rate_limited",
      retryAfterMs: 1000,
    },
    permanent: {
      exchanges: [
        sendBy("SendEmail with a suspended account", () => ({
          status: 400,
          headers: { "x-amzn-errortype": "AccountSuspendedException" },
          body: { message: "Your account has been suspended." },
        })),
      ],
      reason: "auth",
    },
    uncertain: { exchanges: [{ ...sesFixtures.sendServerError, times: undefined }] },
  },
  connect: { ok: [sesFixtures.accountProduction], badKey: [sesFixtures.accountForbidden] },
  webhook: {
    secret: HOOK_TOKEN,
    exchanges: [
      {
        label: "SNS signing certificate",
        method: "GET",
        url: CERT_URL,
        response: () => ({ status: 200, body: certificatePem }),
      },
    ],
    valid: () => signedHook(sesFixtures.bounceEvent),
    // SNS signs fields, not bytes, so change a signed field: the SES event.
    tamper: (request) => {
      const message = JSON.parse(request.body) as { Message: string };
      const changed = { ...message, Message: sesFixtures.deliveryEvent };
      return { ...request, headers: new Headers(request.headers), body: JSON.stringify(changed) };
    },
  },
  events: [
    {
      label: "permanent bounce",
      request: () => hook(snsBody(sesFixtures.bounceEvent, "sns-1")),
      expected: [
        {
          type: "bounce_hard",
          eventId: "sns-1:student1@example.org",
          providerMessageId: "0100018a-ses-message-id",
          email: "student1@example.org",
          detail: "General",
        },
      ],
    },
    {
      label: "transient bounce",
      request: () =>
        hook(
          snsBody(
            JSON.stringify({
              eventType: "Bounce",
              bounce: {
                bounceType: "Transient",
                bounceSubType: "MailboxFull",
                bouncedRecipients: [{ emailAddress: "student2@example.org" }],
                timestamp: "2026-10-19T12:00:00.000Z",
              },
              mail: { messageId: "0100018a-ses-message-2" },
            }),
            "sns-2",
          ),
        ),
      expected: [{ type: "bounce_soft", email: "student2@example.org", detail: "MailboxFull" }],
    },
    {
      label: "complaint",
      request: () => hook(snsBody(sesFixtures.complaintEvent, "sns-3")),
      expected: [{ type: "complaint", email: "student2@example.org", detail: "abuse" }],
    },
    {
      label: "delivery",
      request: () => hook(snsBody(sesFixtures.deliveryEvent, "sns-4")),
      expected: [{ type: "delivered", email: "student3@example.org" }],
    },
    {
      label: "reject",
      request: () =>
        hook(
          snsBody(
            JSON.stringify({
              eventType: "Reject",
              reject: { reason: "Bad content" },
              mail: { messageId: "0100018a-ses-message-5", destination: ["student1@example.org"] },
            }),
            "sns-5",
          ),
        ),
      expected: [{ type: "failed", email: "student1@example.org", detail: "Bad content" }],
    },
  ],
  skip: {
    "webhook.stale":
      "SNS has no replay window to check. Envelopen stores each event once by its SNS message id.",
  },
};
