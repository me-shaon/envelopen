import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createCredentialCipher, createEmailHasher, type Services } from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { svixSign, toSendSignature } from "@envelopen/providers";
import { resendFixtures } from "@envelopen/providers/conformance/fixtures/resend";
import { brevoEvent, brevoFixtures } from "@envelopen/providers/conformance/fixtures/smtp";
import { toSendFixtures } from "@envelopen/providers/conformance/fixtures/tosend";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../test/helpers";
import type { AttemptLimiter } from "../auth/rate-limit-do";
import { outboundFetch } from "../services";
import { createHookRoutes, HOOK_TOKEN_RULE } from "./index";

const KEY = btoa(String.fromCharCode(...new Array(32).fill(3)));
const ORIGIN = "https://envelopen.test";

async function services(): Promise<Partial<Services>> {
  return {
    credentials: await createCredentialCipher([{ version: 1, secret: KEY }]),
    hashEmail: await createEmailHasher(KEY),
    outboundFetch: async () => {
      throw new Error("No outbound request expected.");
    },
    appOrigin: ORIGIN,
  };
}

async function connection(provider: "resend" | "tosend" | "smtp", secret: string) {
  const workspaceId = await createWorkspace(`Hooks ${provider}`);
  const deps = await services();
  const cipher = deps.credentials;
  if (!cipher) throw new Error("No cipher.");
  const row = await createDb(env)
    .db.insertInto("provider_connections")
    .values({
      workspace_id: workspaceId,
      provider,
      name: provider,
      policy: provider === "tosend" ? "transactional-only" : "campaign",
      credentials_encrypted: await cipher.encrypt("{}", { workspaceId, purpose: "credentials" }),
      credentials_key_version: 1,
      webhook_secret_encrypted: await cipher.encrypt(secret, {
        workspaceId,
        purpose: "webhook_secret",
      }),
      events_setup: provider === "smtp" ? "manual" : "auto",
      provider_refs: provider === "smtp" ? JSON.stringify(brevoFixtures.refs) : "{}",
      status: "active",
      status_detail: null,
      policy_warning_accepted_at: null,
      policy_warning_accepted_by: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { workspaceId, connectionId: row.id, deps };
}

async function post(
  path: string,
  body: string,
  headers: Record<string, string>,
  deps: Partial<Services>,
  limiter?: AttemptLimiter,
) {
  const app = createHookRoutes({
    createServices: () => deps,
    ...(limiter ? { limiter: () => limiter } : {}),
  });
  const ctx = createExecutionContext();
  const response = await app.request(
    `${ORIGIN}/${path}`,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function svixHeaders(body: string, id: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await svixSign(resendFixtures.webhookSecret, id, timestamp, body);
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

describe("provider webhook routes", () => {
  it("stores a verified Resend event once, even when it is replayed", async () => {
    const { workspaceId, connectionId, deps } = await connection(
      "resend",
      resendFixtures.webhookSecret,
    );
    const body = resendFixtures.events.bounced;
    const headers = await svixHeaders(body, "msg_route_1");
    const path = `resend/${workspaceId}/${connectionId}`;
    const first = await post(path, body, headers, deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: 1, stored: 1 });
    const replay = await post(path, body, headers, deps);
    expect(await replay.json()).toEqual({ received: 1, stored: 0 });
  });

  it("answers 401 to a bad signature and 404 to an unknown connection, and stores nothing", async () => {
    const { workspaceId, connectionId, deps } = await connection(
      "resend",
      resendFixtures.webhookSecret,
    );
    const body = resendFixtures.events.bounced;
    const headers = await svixHeaders(body, "msg_route_2");
    expect(
      (await post(`resend/${workspaceId}/${connectionId}`, `${body} `, headers, deps)).status,
    ).toBe(401);
    expect((await post(`resend/${workspaceId}/999999`, body, headers, deps)).status).toBe(404);
    expect(
      (await post(`postmark/${workspaceId}/${connectionId}`, body, headers, deps)).status,
    ).toBe(404);
    expect((await post(`resend/abc/${connectionId}`, body, headers, deps)).status).toBe(404);
    const rows = await createDb(env)
      .db.selectFrom("provider_events")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(rows).toEqual([]);
  });

  it("accepts a URL token as the last path segment", async () => {
    const { workspaceId, connectionId, deps } = await connection(
      "resend",
      resendFixtures.webhookSecret,
    );
    const body = resendFixtures.events.bounced;
    const headers = await svixHeaders(body, "msg_route_token");
    const res = await post(`resend/${workspaceId}/${connectionId}/tok_123`, body, headers, deps);
    expect(res.status).toBe(200);
    expect(
      (await post(`resend/${workspaceId}/${connectionId}/a/b`, body, headers, deps)).status,
    ).toBe(404);
  });

  it("verifies a toSend HMAC signature", async () => {
    const { workspaceId, connectionId, deps } = await connection("tosend", "tosend-secret");
    const body = toSendFixtures.events.complaint;
    const signature = await toSendSignature("tosend-secret", body);
    const ok = await post(
      `tosend/${workspaceId}/${connectionId}`,
      body,
      { "x-tosend-signature": signature },
      deps,
    );
    expect(await ok.json()).toEqual({ received: 1, stored: 1 });
    const bad = await post(
      `tosend/${workspaceId}/${connectionId}`,
      body,
      { "x-tosend-signature": "sha256=00" },
      deps,
    );
    expect(bad.status).toBe(401);
  });

  it("refuses a body above 256 KB", async () => {
    const { workspaceId, connectionId, deps } = await connection(
      "resend",
      resendFixtures.webhookSecret,
    );
    const response = await post(
      `resend/${workspaceId}/${connectionId}`,
      "x".repeat(300 * 1024),
      {},
      deps,
    );
    expect(response.status).toBe(413);
  });

  it("stops reading a chunked body without Content-Length at 256 KB", async () => {
    const { workspaceId, connectionId, deps } = await connection(
      "resend",
      resendFixtures.webhookSecret,
    );
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 4 * 1024 * 1024) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const app = createHookRoutes({ createServices: () => deps });
    const ctx = createExecutionContext();
    const response = await app.request(
      `${ORIGIN}/resend/${workspaceId}/${connectionId}`,
      { method: "POST", headers: { "content-type": "application/json" }, body },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(512 * 1024);
  });

  it("is reachable through the Worker entry without a session", async () => {
    const worker = (await import("../index")).default;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/hooks/resend/1/999999`, { method: "POST", body: "{}" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });
});

describe("outbound mock for end-to-end tests", () => {
  it("rewrites every request to the local mock, and refuses another host", async () => {
    let seen = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen = input instanceof Request ? input.url : String(input);
      return new Response("ok");
    }) as typeof fetch;
    try {
      await outboundFetch({ OUTBOUND_MOCK_ORIGIN: "http://127.0.0.1:8799" })(
        "https://api.resend.com/domains?x=1",
      );
      expect(seen).toBe("http://127.0.0.1:8799/api.resend.com/domains?x=1");
    } finally {
      globalThis.fetch = original;
    }
    expect(() => outboundFetch({ OUTBOUND_MOCK_ORIGIN: "https://evil.example" })).toThrow(
      /localhost/,
    );
  });
});

describe("Brevo webhooks of SMTP connections (KTD13)", () => {
  /** A limiter that allows `allowed` requests and records the keys. */
  function countingLimiter(allowed: number) {
    const keys: string[] = [];
    const limiter: AttemptLimiter = {
      async record(key, rule) {
        keys.push(key);
        expect(rule).toEqual(HOOK_TOKEN_RULE);
        return { allowed: keys.length <= allowed, count: keys.length, retryAfterMs: 0 };
      },
      async check() {
        return { allowed: true, count: 0, retryAfterMs: 0 };
      },
      async reset() {},
    };
    return { limiter, keys };
  }

  it("stores an event with the right bearer token and rejects a wrong one", async () => {
    const { workspaceId, connectionId, deps } = await connection("smtp", brevoFixtures.token);
    const { limiter, keys } = countingLimiter(10);
    const body = JSON.stringify(brevoEvent("hard_bounce"));
    const path = `smtp/${workspaceId}/${connectionId}`;
    const ok = await post(
      path,
      body,
      { authorization: `Bearer ${brevoFixtures.token}` },
      deps,
      limiter,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: 1, stored: 1 });
    expect(keys).toEqual([`hook:${workspaceId}:${connectionId}`]);
    const wrong = await post(path, body, { authorization: "Bearer not-the-token" }, deps, limiter);
    expect(wrong.status).toBe(401);
    // A failed verification is not counted against the connection.
    expect(keys).toHaveLength(1);
    const inPath = await post(
      `${path}/${brevoFixtures.token}`,
      body,
      { authorization: `Bearer ${brevoFixtures.token}` },
      deps,
      limiter,
    );
    expect(inPath.status).toBe(404);
  });

  it("answers 429 when the connection is over its cap, and stores nothing", async () => {
    const { workspaceId, connectionId, deps } = await connection("smtp", brevoFixtures.token);
    const { limiter } = countingLimiter(0);
    const response = await post(
      `smtp/${workspaceId}/${connectionId}`,
      JSON.stringify(brevoEvent("spam")),
      { authorization: `Bearer ${brevoFixtures.token}` },
      deps,
      limiter,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    const rows = await createDb(env)
      .db.selectFrom("provider_events")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(rows).toEqual([]);
  });
});
