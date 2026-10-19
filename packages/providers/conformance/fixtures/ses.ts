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
