import { deriveHmacKey, hmacHex } from "@envelopen/core";

// Form protection for the preference page (KTD30). The page's forms change state, so:
//
// - Each form carries a field that only this deployment can compute: an HMAC of the
//   page's token under a key that HKDF derives from SIGNING_KEY with its own label.
// - A POST whose browser says it comes from another site is refused (`isSameOriginPost`).
//
// The RFC 8058 one-click POST is not a form of this page. A mail provider's server
// sends it without cookies or an Origin, and the token in the URL is its credential.

const FORM_KEY_LABEL = "envelopen/forms/v1";

let cached: { secret: string; key: Promise<CryptoKey> } | undefined;

function formKey(signingKey: string): Promise<CryptoKey> {
  if (cached?.secret !== signingKey) {
    cached = { secret: signingKey, key: deriveHmacKey(signingKey, FORM_KEY_LABEL) };
  }
  return cached.key;
}

/** The value of the hidden `csrf` field for the page of `token`. */
export async function formToken(signingKey: string, token: string): Promise<string> {
  return (await hmacHex(await formKey(signingKey), `form|${token}`)).slice(0, 32);
}

/** Compares in time that depends only on the length. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * False when the browser reports that the form came from another site. `Sec-Fetch-Site`
 * decides when the browser sends it. Without it, an `Origin` must be this origin, or
 * `null`: a browser sends `null` when the page's referrer policy hides the origin.
 */
export function isSameOriginPost(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  return origin === null || origin === "null" || origin === new URL(request.url).origin;
}
