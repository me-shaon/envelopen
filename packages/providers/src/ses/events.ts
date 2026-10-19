import type { NormalizedEvent, ParsedWebhook, ProviderEventType } from "../types";
import { isSnsUrl, parseSnsMessage, topicRegion } from "./sns-verify";

// SES event publishing through SNS. The SNS `Message` field holds the SES event JSON.
// https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
//
// One SES event can name several recipients, so it becomes one event per recipient.
// The event id is the SNS message id and the address: SNS retries keep the message id.

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    timestamp?: string;
    bouncedRecipients?: { emailAddress?: string }[];
  };
  complaint?: {
    timestamp?: string;
    complaintFeedbackType?: string;
    complainedRecipients?: { emailAddress?: string }[];
  };
  delivery?: { timestamp?: string; recipients?: string[] };
  reject?: { reason?: string };
}

function time(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function parseSesWebhook(body: string): ParsedWebhook {
  const sns = parseSnsMessage(body);
  if (!sns) return { events: [] };
  if (sns.Type === "SubscriptionConfirmation") {
    const region = topicRegion(sns.TopicArn);
    const url = sns.SubscribeURL;
    // Only an SNS host of the topic's region. Anything else would make Envelopen fetch an
    // address that the sender chose.
    return region && url && isSnsUrl(url, region)
      ? { events: [], confirmSubscriptionUrl: url }
      : { events: [] };
  }
  if (sns.Type !== "Notification") return { events: [] };

  let event: SesEvent;
  try {
    event = JSON.parse(sns.Message) as SesEvent;
  } catch {
    return { events: [] };
  }
  const kind = event.eventType ?? event.notificationType;
  const messageId = event.mail?.messageId ?? null;
  const fallback = time(sns.Timestamp, Date.now());
  const events: NormalizedEvent[] = [];
  const add = (type: ProviderEventType, email: string | undefined, at: number, detail?: string) => {
    if (!email) return;
    events.push({
      type,
      eventId: `${sns.MessageId}:${email.toLowerCase()}`,
      providerMessageId: messageId,
      email,
      occurredAt: at,
      ...(detail ? { detail } : {}),
    });
  };

  switch (kind) {
    case "Delivery":
      for (const email of event.delivery?.recipients ?? []) {
        add("delivered", email, time(event.delivery?.timestamp, fallback));
      }
      break;
    case "Bounce": {
      // Permanent is a hard bounce. Transient and Undetermined count as soft (R44).
      const hard = event.bounce?.bounceType === "Permanent";
      for (const recipient of event.bounce?.bouncedRecipients ?? []) {
        add(
          hard ? "bounce_hard" : "bounce_soft",
          recipient.emailAddress,
          time(event.bounce?.timestamp, fallback),
          event.bounce?.bounceSubType,
        );
      }
      break;
    }
    case "Complaint":
      // A "not-spam" feedback report is not a complaint.
      if (event.complaint?.complaintFeedbackType === "not-spam") break;
      for (const recipient of event.complaint?.complainedRecipients ?? []) {
        add(
          "complaint",
          recipient.emailAddress,
          time(event.complaint?.timestamp, fallback),
          event.complaint?.complaintFeedbackType,
        );
      }
      break;
    case "Reject":
    case "Rendering Failure":
      for (const email of event.mail?.destination ?? []) {
        add("failed", email, fallback, event.reject?.reason ?? kind);
      }
      break;
    default:
      break;
  }
  return { events };
}
