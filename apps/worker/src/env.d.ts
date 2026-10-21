// Secrets. `wrangler types` cannot see them (there is no .dev.vars in the repository),
// so they are declared here. Each one is optional: the first-run screen reports a
// missing secret instead of the Worker failing at startup.
interface EnvelopenSecrets {
  /** Opens the first-run screen and setup-token recovery. At least 32 characters (KTD6). */
  SETUP_TOKEN?: string;
  /** Base64, 32 bytes. Encrypts provider credentials (AES-GCM). */
  ENCRYPTION_KEY?: string;
  /** Base64, 32 bytes. Signs tokens. The Better Auth secret is derived from it. */
  SIGNING_KEY?: string;
  /**
   * Comma-separated earlier SIGNING_KEY values. Unsubscribe and tracking links that an
   * old key signed keep working after a rotation (KTD28).
   */
  SIGNING_KEYS_RETIRED?: string;
  /**
   * The Turnstile widget's site key for signup forms (U8, KTD6). Without it and
   * TURNSTILE_SECRET, forms show a setup notice and refuse submissions.
   */
  TURNSTILE_SITE_KEY?: string;
  /** The Turnstile widget's secret key, for siteverify. */
  TURNSTILE_SECRET?: string;
  /**
   * End-to-end tests only: a localhost origin that receives every outbound provider and
   * DNS request instead of the real host. Never set it on a deployed Worker.
   */
  OUTBOUND_MOCK_ORIGIN?: string;
  /**
   * End-to-end tests only: a shorter EventBuffer flush delay in milliseconds, so stats
   * show tracking events without the 30-second wait. Ignored outside 100 to 30,000.
   */
  EVENT_FLUSH_DELAY_MS?: string;
}

declare namespace Cloudflare {
  interface Env extends EnvelopenSecrets {}
}
interface Env extends EnvelopenSecrets {}
