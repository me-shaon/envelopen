// A minimal DER reader: just enough to take the public key out of an X.509 certificate,
// so WebCrypto can import it as SPKI. Workers have no X.509 API.

interface Element {
  tag: number;
  /** Offset of the first byte of the element (its tag). */
  start: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset after the last content byte. */
  end: number;
}

function readElement(bytes: Uint8Array, offset: number): Element {
  const tag = bytes[offset];
  let lengthByte = bytes[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new Error("DER: truncated element.");
  let cursor = offset + 2;
  let length = lengthByte;
  if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f;
    if (count === 0 || count > 4) throw new Error("DER: unsupported length.");
    length = 0;
    for (let i = 0; i < count; i++) {
      lengthByte = bytes[cursor++];
      if (lengthByte === undefined) throw new Error("DER: truncated length.");
      length = length * 256 + lengthByte;
    }
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("DER: element runs past the end.");
  return { tag, start: offset, contentStart: cursor, end };
}

function childrenOf(bytes: Uint8Array, parent: Element): Element[] {
  const items: Element[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const item = readElement(bytes, offset);
    items.push(item);
    offset = item.end;
  }
  return items;
}

const SEQUENCE = 0x30;
const EXPLICIT_VERSION = 0xa0;

/** The DER bytes of a PEM block. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----[\s\S]*$/, "")
    .replaceAll(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The SubjectPublicKeyInfo of a certificate. Certificate is SEQUENCE { tbsCertificate,
 * signatureAlgorithm, signature }, and tbsCertificate is SEQUENCE { [0] version
 * (optional), serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, ... }.
 */
export function certificateSpki(der: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const certificate = readElement(der, 0);
  if (certificate.tag !== SEQUENCE) throw new Error("DER: the certificate is not a SEQUENCE.");
  const tbs = childrenOf(der, certificate)[0];
  if (!tbs || tbs.tag !== SEQUENCE) throw new Error("DER: no tbsCertificate.");
  const fields = childrenOf(der, tbs);
  const first = fields[0]?.tag === EXPLICIT_VERSION ? 1 : 0;
  const spki = fields[first + 5];
  if (!spki || spki.tag !== SEQUENCE) throw new Error("DER: no subjectPublicKeyInfo.");
  return der.slice(spki.start, spki.end);
}
