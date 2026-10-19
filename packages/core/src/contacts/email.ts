// Email addresses are trimmed and lowercased before the unique check (R73). The same
// normalized form feeds the suppression hash, so `Ana@Example.com ` and
// `ana@example.com` are one contact and one suppression.

const MAX_LENGTH = 254;
// A practical check, not full RFC 5322: a local part without spaces or quotes, one @,
// and a domain with at least one dot and labels of letters, digits, and hyphens.
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Trims and lowercases an address. Returns null when the result is not a valid address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_LENGTH) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  const local = email.slice(0, email.indexOf("@"));
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return null;
  }
  return email;
}
