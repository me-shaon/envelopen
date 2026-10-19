import { Hono } from "hono";
import { fileLinkSigner } from "../services";

// Downloads of signed file links: import error files and contact exports. The link is
// the credential, so this route needs no session. It stops working when the link
// expires (24 hours, R18) or when the cron deletes the file.

function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\w.-]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createFileRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/:token", async (c) => {
    const signer = fileLinkSigner(c.env);
    const file = signer ? await (await signer).verify(c.req.param("token")) : null;
    const object = file ? await c.env.BUCKET.get(file.key) : null;
    if (!file || !object) {
      return c.text("This download link is not valid, or it has expired.", 404, {
        "Cache-Control": "no-store",
      });
    }
    return new Response(object.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition(file.filename),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
  return app;
}
