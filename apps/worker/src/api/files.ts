import { backupIdOfLinkKey, streamBackupArchive } from "@envelopen/core";
import { Hono } from "hono";
import { fileLinkSigner } from "../services";

// Downloads of signed file links: import error files, contact exports, and backup
// archives. The link is the credential, so this route needs no session. It stops
// working when the link expires (24 hours for files, R18; 15 minutes for a backup) or
// when the cron deletes the file.
//
// A backup link (U5) names a virtual key `backups/<id>/archive.envbak`. The route
// streams the single-file archive from the backup's R2 objects: the header and the
// manifest, then each chunk in order (packages/core/src/backup/archive.ts). It holds
// one chunk at a time, and the response has a fixed length.

function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\w.-]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createFileRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/:token", async (c) => {
    const signer = fileLinkSigner(c.env);
    const file = signer ? await (await signer).verify(c.req.param("token")) : null;
    const backupId = file ? backupIdOfLinkKey(file.key) : null;
    if (file && backupId) {
      const archive = await streamBackupArchive(c.env.BUCKET, backupId);
      if (archive) {
        const fixed = new FixedLengthStream(archive.size);
        // The response body drives the pipe, so the Worker keeps it running.
        void archive.body.pipeTo(fixed.writable).catch((error: unknown) => {
          console.error("The backup download stopped", error);
        });
        return new Response(fixed.readable, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(archive.size),
            "Content-Disposition": contentDisposition(file.filename),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
    }
    const object = file && !backupId ? await c.env.BUCKET.get(file.key) : null;
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
