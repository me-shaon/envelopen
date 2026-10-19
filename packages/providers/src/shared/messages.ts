import type {
  Credentials,
  OutgoingMessage,
  ProviderAdapter,
  RecipientResult,
  SendBatchResult,
  SendContext,
} from "../types";

// Rules that hold for every adapter, checked in one place before any provider call.

/** Gmail and Yahoo require both headers for bulk senders (R25). */
export const LIST_UNSUBSCRIBE = "List-Unsubscribe";
export const LIST_UNSUBSCRIBE_POST = "List-Unsubscribe-Post";
export const ONE_CLICK_VALUE = "List-Unsubscribe=One-Click";

export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageError";
  }
}

function header(message: OutgoingMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(message.headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Throws when a message breaks the contract: a campaign or test message without both
 * unsubscribe headers, a header value with a line break, or a batch that is too large.
 */
export function assertMessages(messages: readonly OutgoingMessage[], batchSize: number): void {
  if (messages.length === 0) throw new MessageError("The batch is empty.");
  if (messages.length > batchSize) {
    throw new MessageError(`The batch has ${messages.length} messages. The limit is ${batchSize}.`);
  }
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.recipientId)) {
      throw new MessageError(`Recipient ${message.recipientId} is in the batch twice.`);
    }
    ids.add(message.recipientId);
    for (const [name, value] of Object.entries(message.headers)) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw new MessageError(`Header ${name} has a line break.`);
      }
    }
    if (message.kind === "system") continue;
    const unsubscribe = header(message, LIST_UNSUBSCRIBE);
    if (!unsubscribe || !/<https:\/\/[^>]+>/.test(unsubscribe)) {
      throw new MessageError(`A ${message.kind} message needs an HTTPS List-Unsubscribe header.`);
    }
    if (header(message, LIST_UNSUBSCRIBE_POST) !== ONE_CLICK_VALUE) {
      throw new MessageError(
        `A ${message.kind} message needs List-Unsubscribe-Post: ${ONE_CLICK_VALUE}.`,
      );
    }
  }
}

/**
 * Sends a batch through an adapter with the contract checks around it: the messages
 * before the call, and one result per message, in order, after it. Callers use this,
 * not `adapter.sendBatch`, so a faulty adapter cannot lose a recipient.
 */
export async function sendBatch(
  adapter: ProviderAdapter,
  messages: readonly OutgoingMessage[],
  credentials: Credentials,
  ctx: SendContext,
): Promise<SendBatchResult> {
  assertMessages(messages, adapter.capabilities.batchSize);
  const result = await adapter.sendBatch(messages, credentials, ctx);
  const byId = new Map<string, RecipientResult>();
  for (const item of result.results) byId.set(item.recipientId, item);
  // A missing result is unknown: the provider may have sent the message.
  const results = messages.map(
    (message) =>
      byId.get(message.recipientId) ?? {
        recipientId: message.recipientId,
        outcome: "unknown" as const,
        reason: "server_error" as const,
        message: "The provider returned no result for this recipient.",
      },
  );
  return result.failure ? { results, failure: result.failure } : { results };
}

/** The address part of a mailbox such as `Ana <ana@example.com>`. */
export function mailboxAddress(mailbox: string): string {
  const match = /<([^>]+)>\s*$/.exec(mailbox);
  return (match?.[1] ?? mailbox).trim();
}

/** The display name of a mailbox, or null. */
export function mailboxName(mailbox: string): string | null {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(mailbox);
  const name = match?.[1]?.trim();
  return name ? name : null;
}
