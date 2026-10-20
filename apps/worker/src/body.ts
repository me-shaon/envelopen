// Size caps for request bodies on public routes. A chunked request has no
// Content-Length, so the cap counts the bytes while it reads the stream and stops at
// the first byte over the cap. The rest of the body is never read.

/**
 * Reads the body of a request up to `maxBytes`. Returns null when the declared length
 * or the bytes read go over the cap. Reads the raw stream, so read the body only here.
 */
export async function readBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A copy of the request with the body that `readBodyLimited` read. */
export function withBody(request: Request, body: Uint8Array<ArrayBuffer>): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : body,
  });
}
