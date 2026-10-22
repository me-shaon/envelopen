import { parseLogoPath, sniffImage } from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { Hono } from "hono";
import { usageSink } from "../do/usage";

// Brand logos: GET /b/<workspace id>/<sha-256>.<ext> (U13). Emails load the logo from
// here, so the route needs no session. The key is content-addressed, so the bytes behind
// a URL never change and caches may keep them for a year.
//
// The response always carries the stored type, which the upload took from the file's
// magic bytes, with `nosniff`, so a browser never reads the file as another type. A
// restored deployment has the logo rows in D1 but not the R2 objects: the route then
// serves the bytes from D1 and writes the object back to R2.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function notFound(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function imageResponse(body: ReadableStream | Uint8Array | null, type: string, size: number) {
  return new Response(body as BodyInit | null, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

export interface BrandRouteDeps {
  db(env: Env): DbConnection;
}

const defaultDeps: BrandRouteDeps = {
  db: (env) => createDb(env, { usageSink: usageSink(env) }),
};

export function createBrandRoutes(deps: BrandRouteDeps = defaultDeps) {
  const app = new Hono<{ Bindings: Env }>();
  app.on(["GET", "HEAD"], "/:workspaceId/:file", async (c) => {
    const logo = parseLogoPath(`${c.req.param("workspaceId")}/${c.req.param("file")}`);
    if (!logo) return notFound();
    const head = c.req.method === "HEAD";
    const object = await c.env.BUCKET.get(logo.key);
    if (object) {
      const type = object.httpMetadata?.contentType ?? "";
      if (!IMAGE_TYPES.has(type)) return notFound();
      return imageResponse(head ? null : object.body, type, object.size);
    }
    const row = await deps
      .db(c.env)
      .db.selectFrom("brand_logos")
      .select(["content_type", "bytes"])
      .where("workspace_id", "=", logo.workspaceId)
      .where("key", "=", logo.key)
      .executeTakeFirst();
    const bytes = bytesOf(row?.bytes);
    // The stored bytes pass the same check as an upload before they are served.
    if (!row || !bytes || sniffImage(bytes)?.contentType !== row.content_type) return notFound();
    await c.env.BUCKET.put(logo.key, bytes, {
      httpMetadata: {
        contentType: row.content_type,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    return imageResponse(head ? null : bytes, row.content_type, bytes.length);
  });
  return app;
}
