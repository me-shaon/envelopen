import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

// Placeholder for the unsubscribe and preference pages (U10).
app.get("/u/:token", (c) => c.text("Envelopen subscription page"));

export default {
  fetch: app.fetch,

  async queue(batch, _env, _ctx) {
    // The send consumer (U9) replaces this stub.
    batch.ackAll();
  },

  async scheduled(_controller, _env, _ctx) {
    // The recovery sweep (U9) replaces this stub.
  },
} satisfies ExportedHandler<Env>;
