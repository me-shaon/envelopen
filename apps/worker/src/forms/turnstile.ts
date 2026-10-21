// Turnstile siteverify (KTD6, R11). The browser gets a one-time token from the widget on
// the hosted form page. The Worker sends it with the secret to siteverify and accepts the
// submission only when:
//
// - `success` is true,
// - `hostname` is the host of the form page (the token was not made on another site), and
// - `action` is the action of the widget (`signup` or `resend`), so a token from one
//   widget cannot be used for the other.
//
// The call goes through `outboundFetch`, so the end-to-end tests answer it with the local
// provider mock. Cloudflare's documented test secrets answer with the hostname
// `example.com` and no action. With a test secret, only `success` counts: the test site
// keys have no real bot check anyway.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's test secrets: 1x passes, 2x fails, 3x reports a spent token. */
const TEST_SECRET = /^[123]x0{31}AA$/;
/** Turnstile tokens are at most 2048 characters. */
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 10_000;

export interface TurnstileKeys {
  siteKey: string;
  secret: string;
}

/** The keys from the environment, or null when one is missing. */
export function turnstileKeys(
  env: Pick<Env, "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET">,
): TurnstileKeys | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secret = env.TURNSTILE_SECRET?.trim();
  return siteKey && secret ? { siteKey, secret } : null;
}

export interface VerifyRequest {
  token: string;
  /** The client IP, sent as `remoteip`. */
  ip: string | null;
  hostname: string;
  action: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export async function verifyTurnstile(
  fetcher: typeof fetch,
  secret: string,
  request: VerifyRequest,
): Promise<VerifyResult> {
  const token = request.token.trim();
  if (token.length === 0) return { ok: false, reason: "missing-input-response" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid-input-response" };
  const body = new URLSearchParams({ secret, response: token });
  if (request.ip && request.ip !== "unknown") body.set("remoteip", request.ip);
  let data: SiteverifyResponse;
  try {
    const response = await fetcher(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `siteverify-status-${response.status}` };
    data = (await response.json()) as SiteverifyResponse;
  } catch (error) {
    console.error("Turnstile siteverify failed", error);
    return { ok: false, reason: "siteverify-unreachable" };
  }
  if (data.success !== true) {
    return { ok: false, reason: data["error-codes"]?.join(",") || "not-success" };
  }
  if (TEST_SECRET.test(secret)) return { ok: true };
  if (data.hostname?.toLowerCase() !== request.hostname.toLowerCase()) {
    return { ok: false, reason: "hostname-mismatch" };
  }
  if (data.action !== request.action) return { ok: false, reason: "action-mismatch" };
  return { ok: true };
}
