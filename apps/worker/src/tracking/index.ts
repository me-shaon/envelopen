import { Hono } from "hono";
import { hitOf } from "./classify";
import { handleClick, INVALID_LINK_PATH, recordHoneypot } from "./click";
import { type TrackingDepsFactory, trackingDeps } from "./deps";
import { pixelResponse, recordOpen } from "./pixel";
import { publicPage } from "./preferences";

// Tracking routes under /t (R40, KTD29). The routes answer at once. The token check
// for the pixel and the honeypot, and every hand-off to the EventBuffer, run after the
// response through `waitUntil`. The click route checks the token first, because the
// redirect needs the stored URL.
//
//   GET|HEAD /t/o/<token>          open pixel
//   GET|HEAD /t/c/<token>/<index>  click on link <index>
//   GET|HEAD /t/h/<token>          the hidden honeypot link
//   GET      /t/invalid            the generic page of a link that is not valid

export { createUnsubscribeRoutes } from "./unsubscribe";

export interface TrackingRoutesOptions {
  deps?: TrackingDepsFactory;
}

export function createTrackingRoutes(options: TrackingRoutesOptions = {}) {
  const makeDeps = options.deps ?? trackingDeps;
  const app = new Hono<{ Bindings: Env }>();

  const later = (
    c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
    work: () => Promise<unknown>,
  ) => {
    c.executionCtx.waitUntil(
      work().catch((error) => console.error("Tracking event failed", error)),
    );
  };

  app.on(["GET", "HEAD"], "/o/:token", (c) => {
    const deps = makeDeps(c.env);
    const hit = hitOf(c.req.raw);
    const now = deps.now();
    later(c, async () => {
      try {
        await recordOpen(deps, c.req.param("token"), hit, now);
      } finally {
        await deps.db.meter.flush();
      }
    });
    return pixelResponse(c.req.method);
  });

  app.on(["GET", "HEAD"], "/c/:token/:index", async (c) => {
    const deps = makeDeps(c.env);
    let outcome: Awaited<ReturnType<typeof handleClick>>;
    try {
      outcome = await handleClick(
        deps,
        c.req.param("token"),
        c.req.param("index"),
        hitOf(c.req.raw),
      );
    } catch (error) {
      console.error("Click lookup failed", error);
      outcome = { location: INVALID_LINK_PATH, record: null };
    }
    const record = outcome.record;
    later(c, async () => {
      try {
        if (record) await record();
      } finally {
        await deps.db.meter.flush();
      }
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: outcome.location,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
      },
    });
  });

  app.on(["GET", "HEAD"], "/h/:token", (c) => {
    const deps = makeDeps(c.env);
    later(c, async () => {
      try {
        await recordHoneypot(deps, c.req.param("token"));
      } finally {
        await deps.db.meter.flush();
      }
    });
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  });

  app.get("/invalid", (c) => publicPage(makeDeps(c.env), { kind: "link_invalid" }, 404));
  app.all("*", (c) => publicPage(makeDeps(c.env), { kind: "link_invalid" }, 404));
  return app;
}
