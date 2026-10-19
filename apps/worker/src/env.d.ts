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
   * End-to-end tests only: a localhost origin that receives every outbound provider and
   * DNS request instead of the real host. Never set it on a deployed Worker.
   */
  OUTBOUND_MOCK_ORIGIN?: string;
}

declare namespace Cloudflare {
  interface Env extends EnvelopenSecrets {}
}
interface Env extends EnvelopenSecrets {}
