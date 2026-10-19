import { base64ToBytes, utf8 } from "../shared/encoding";
import { certificateSpki, pemToDer } from "./der";

// Amazon SNS message signatures (SignatureVersion 1 and 2).
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html
//
// SNS signs a canonical string of some message fields with the private key of a
// certificate at `SigningCertURL`. The certificate is trusted because it comes over
// HTTPS from an AWS host, so the host check is the security boundary: a certificate
// from anywhere else would let anyone sign. Envelopen also requires the region of the
// connection, so a topic in another region cannot reach this connection.

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

const NOTIFICATION_FIELDS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const CONFIRMATION_FIELDS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const TOPIC_ARN = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/;

/** Parses an SNS body. Returns null when it is not an SNS message. */
export function parseSnsMessage(body: string): SnsMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  const required = ["Type", "MessageId", "TopicArn", "Timestamp", "Signature", "SigningCertURL"];
  for (const field of required) if (typeof message[field] !== "string") return null;
  if (typeof message.Message !== "string") return null;
  if (
    !["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(
      message.Type as string,
    )
  ) {
    return null;
  }
  return {
    ...(message as unknown as SnsMessage),
    SignatureVersion: String(message.SignatureVersion ?? "1"),
  };
}

/** The region of a topic ARN, or null. */
export function topicRegion(topicArn: string): string | null {
  return TOPIC_ARN.exec(topicArn)?.[1] ?? null;
}

/**
 * True when a URL is an SNS endpoint of the region: HTTPS, the host
 * `sns.<region>.amazonaws.com`, no port, and no user info. `extension` checks the path,
 * for example `.pem` for a signing certificate.
 */
export function isSnsUrl(value: string, region: string, extension?: string): boolean {
  if (!REGION_PATTERN.test(region)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  if (url.hostname !== `sns.${region}.amazonaws.com`) return false;
  return extension === undefined || url.pathname.endsWith(extension);
}

/** The canonical string that SNS signs: `Key\nValue\n` for each field, in order. */
export function stringToSign(message: SnsMessage): string {
  const fields = message.Type === "Notification" ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  let text = "";
  for (const field of fields) {
    const value = (message as unknown as Record<string, unknown>)[field];
    // Subject appears only when the publisher set one.
    if (value === undefined || value === null) {
      if (field === "Subject") continue;
      return "";
    }
    text += `${field}\n${String(value)}\n`;
  }
  return text;
}

/** Imported keys by certificate URL and hash. A Worker isolate reuses them across requests. */
const keyCache = new Map<string, Promise<CryptoKey | null>>();
const MAX_CACHED_KEYS = 20;

async function loadKey(
  certUrl: string,
  hash: "SHA-1" | "SHA-256",
  fetcher: typeof fetch,
): Promise<CryptoKey | null> {
  const cacheKey = `${hash} ${certUrl}`;
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetcher(certUrl, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return null;
        const spki = certificateSpki(pemToDer(await response.text()));
        return await crypto.subtle.importKey(
          "spki",
          spki,
          { name: "RSASSA-PKCS1-v1_5", hash },
          false,
          ["verify"],
        );
      } catch {
        return null;
      }
    })();
    if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
    keyCache.set(cacheKey, pending);
    // A failed load is not cached, so the next message tries again.
    void pending.then((key) => {
      if (!key) keyCache.delete(cacheKey);
    });
  }
  return pending;
}

/** Clears the certificate cache. Tests use it. */
export function clearSnsKeyCache(): void {
  keyCache.clear();
}

export type SnsVerification = { ok: true } | { ok: false; reason: string };

/** Verifies the signature of an SNS message from a topic in `region`. */
export async function verifySnsSignature(
  message: SnsMessage,
  region: string,
  fetcher: typeof fetch,
): Promise<SnsVerification> {
  const hash =
    message.SignatureVersion === "2"
      ? "SHA-256"
      : message.SignatureVersion === "1"
        ? "SHA-1"
        : null;
  if (!hash) return { ok: false, reason: "Unknown SignatureVersion." };
  if (topicRegion(message.TopicArn) !== region) {
    return { ok: false, reason: "The topic is not in the region of the connection." };
  }
  if (!isSnsUrl(message.SigningCertURL, region, ".pem")) {
    return { ok: false, reason: "The certificate URL is not an SNS host of the region." };
  }
  const canonical = stringToSign(message);
  const signature = base64ToBytes(message.Signature);
  if (!canonical || !signature) return { ok: false, reason: "The message is incomplete." };
  const key = await loadKey(message.SigningCertURL, hash, fetcher);
  if (!key) return { ok: false, reason: "The signing certificate could not be loaded." };
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, utf8(canonical));
  return valid ? { ok: true } : { ok: false, reason: "The signature does not match." };
}
