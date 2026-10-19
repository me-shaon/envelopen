import { cloudflareAdapter } from "./cloudflare";
import { postmarkAdapter } from "./postmark";
import { resendAdapter } from "./resend";
import { sesAdapter } from "./ses";
import { toSendAdapter } from "./tosend";
import type { ProviderAdapter } from "./types";

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
export { toSendAdapter, toSendSignature } from "./tosend";
export * from "./types";

/** The built-in adapters (R9). A new adapter joins this list and nothing else (R65). */
export const ADAPTERS: readonly ProviderAdapter[] = [
  sesAdapter,
  resendAdapter,
  postmarkAdapter,
  toSendAdapter,
  cloudflareAdapter,
];

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id: string): ProviderAdapter | undefined {
  return BY_ID.get(id);
}
