import { cloudflareAdapter } from "./cloudflare";
import { postmarkAdapter } from "./postmark";
import { resendAdapter } from "./resend";
import { sesAdapter } from "./ses";
import { smtpAdapter } from "./smtp";
import { toSendAdapter } from "./tosend";
import type { ProviderAdapter } from "./types";

export {
  BREVO_WEBHOOK_EVENTS,
  bearerMatches,
  parseBrevoEvents,
  verifyBrevoWebhook,
} from "./brevo/webhooks";
export { cloudflareAdapter } from "./cloudflare";
export { postmarkAdapter, postmarkAuthorization } from "./postmark";
export { resendAdapter } from "./resend";
export { svixSign, verifySvix } from "./resend/svix-verify";
export { sesAdapter } from "./ses";
export { isSnsUrl, verifySnsSignature } from "./ses/sns-verify";
export { randomSecret, timingSafeEqual } from "./shared/encoding";
export {
  assertMessages,
  LIST_UNSUBSCRIBE,
  LIST_UNSUBSCRIBE_POST,
  MessageError,
  ONE_CLICK_VALUE,
  sendBatch,
} from "./shared/messages";
export { presetOf, SMTP_BATCH_SIZE, SMTP_BATCH_SIZE_FREE, smtpAdapter, smtpSettings } from "./smtp";
export {
  BREVO_FREE_DAILY_CAP,
  GMAIL_DAILY_CAP,
  GMAIL_POLICY_WARNING,
  SMTP_PRESETS,
  type SmtpPresetId,
  smtpPreset,
  WORKSPACE_DAILY_CAP,
  WORKSPACE_POLICY_WARNING,
} from "./smtp/presets";
export { toSendAdapter, toSendSignature } from "./tosend";
export * from "./types";

/** The built-in adapters (R9). A new adapter joins this list and nothing else (R65). */
export const ADAPTERS: readonly ProviderAdapter[] = [
  sesAdapter,
  resendAdapter,
  postmarkAdapter,
  toSendAdapter,
  cloudflareAdapter,
  smtpAdapter,
];

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id: string): ProviderAdapter | undefined {
  return BY_ID.get(id);
}

/** The batch size of an adapter on the owner's Workers plan (Trial 1 of U17). */
export function batchSizeFor(adapter: ProviderAdapter, plan: "free" | "paid"): number {
  const { batchSize, batchSizeOnFree } = adapter.capabilities;
  return plan === "free" && batchSizeOnFree ? Math.min(batchSize, batchSizeOnFree) : batchSize;
}
