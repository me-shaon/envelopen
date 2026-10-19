export { type FlushResult, flushEvents } from "./flush";
export {
  type BufferedEvent,
  bufferKey,
  FLUSH_DELAY_MS,
  FLUSH_SIZE,
  isBufferedEvent,
  type ProviderEventRef,
  SOFT_BOUNCE_LIMIT,
  SOFT_BOUNCE_WINDOW_MS,
  type TrackingEvent,
  type TrackingEventType,
} from "./model";
export {
  isHttpUrl,
  resolveClick,
  resolveRecipient,
  type TrackedClick,
  type TrackedRecipient,
} from "./resolve";
export {
  DAY_MS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  purgeExpiredEvents,
  RETENTION_BATCH,
  type RetentionResult,
  unappliedProviderEvents,
} from "./retention";
export {
  loadSubscription,
  resubscribe,
  type Subscription,
  type SubscriptionList,
  savePreferences,
  type UnsubscribeSource,
  unsubscribeAll,
} from "./subscription";
