import { type Operation, registry, runOperation } from "@envelopen/core";
import { describe, expect, it } from "vitest";
import { SIGNING_KEY as SIGNING } from "../../test/campaign-helpers";
import {
  call,
  LATER,
  mount,
  pathOf,
  type RecordingDeps,
  recordingDeps,
  type SentCampaign,
  sentCampaign,
} from "../../test/tracking-helpers";
import { formToken } from "./csrf";
import { createUnsubscribeRoutes } from "./unsubscribe";

// Unsubscribe and the preference page (KTD30, R24, R25, R64, F3, AE5).

async function setup(): Promise<{
  sent: SentCampaign;
  deps: RecordingDeps;
  app: ReturnType<typeof mount>;
}> {
  const sent = await sentCampaign();
  const deps = await recordingDeps(sent.db);
  return { sent, deps, app: mount("/u", createUnsubscribeRoutes({ deps: () => deps })) };
}

async function contact(sent: SentCampaign, index = 0) {
  const get = registry.get("contacts.get") as Operation;
  return (await runOperation(
    sent.seeded.principal,
    get,
    { id: sent.recipients[index]?.contact_id },
    { db: sent.db },
  )) as {
    status: string;
    unsubscribedAt: number | null;
    unsubscribeSource: string | null;
    unsubscribeCampaignId: number | null;
    lists: { status: string; source: string; campaignId: number | null }[];
  };
}

function oneClickUrlencoded(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  };
}

function oneClickMultipart(): RequestInit {
  const body = new FormData();
  body.set("List-Unsubscribe", "One-Click");
  return { method: "POST", body };
}

async function formPost(token: string, fields: Record<string, string | string[]>, csrf?: string) {
  const body = new URLSearchParams();
  body.set("csrf", csrf ?? (await formToken(SIGNING, token)));
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://envelopen.test",
      "sec-fetch-site": "same-origin",
    },
    body: body.toString(),
  } satisfies RequestInit;
}

describe("one-click unsubscribe (RFC 8058)", () => {
  it("covers AE5 and F3: a POST in either content type unsubscribes without a redirect, and the contact stays visible", async () => {
    for (const [index, init] of [oneClickUrlencoded(), oneClickMultipart()].entries()) {
      const { sent, deps, app } = await setup();
      const token = sent.tokens[0] as string;
      const response = await call(app, `/u/${token}`, init);
      expect(response.status, `content type ${index}`).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toContain("You are unsubscribed");

      const after = await contact(sent);
      expect(after.status).toBe("unsubscribed");
      expect(after.unsubscribedAt).toBe(LATER);
      expect(after.unsubscribeSource).toBe("one_click");
      expect(after.unsubscribeCampaignId).toBe(sent.campaignId);
      expect(after.lists).toEqual([
        expect.objectContaining({
          status: "unsubscribed",
          source: "one_click",
          campaignId: sent.campaignId,
        }),
      ]);
      // The other recipient is untouched.
      expect((await contact(sent, 1)).status).toBe("subscribed");
      expect(deps.events.map(({ event }) => event.source === "tracking" && event.type)).toEqual([
        "unsubscribe",
      ]);

      // A second POST changes nothing and records no second event.
      expect((await call(app, `/u/${token}`, oneClickUrlencoded())).status).toBe(200);
      expect(deps.events).toHaveLength(1);
    }
  });

  it("refuses a chunked form above 16 KB without reading it all", async () => {
    const { sent, app } = await setup();
    const token = sent.tokens[0] as string;
    const encoder = new TextEncoder();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("List-Unsubscribe=One-Click&pad="));
      },
      pull(controller) {
        if (pulled >= 1024 * 1024) return controller.close();
        pulled += 4096;
        controller.enqueue(encoder.encode("x".repeat(4096)));
      },
    });
    const response = await call(app, `/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThan(64 * 1024);
    expect((await contact(sent)).status).toBe("subscribed");
  });

  it("works for the URL in the List-Unsubscribe header of the sent email", async () => {
    const { sent, app } = await setup();
    const header = sent.emails[0]?.headers["List-Unsubscribe"] ?? "";
    const url = header.slice(1, -1);
    expect((await call(app, pathOf(url), oneClickUrlencoded())).status).toBe(200);
    const unsubscribed = await Promise.all([contact(sent, 0), contact(sent, 1)]);
    expect(unsubscribed.filter((row) => row.status === "unsubscribed")).toHaveLength(1);
  });

  it("refuses a POST without the one-click body, and a forged token, and changes nothing", async () => {
    const { sent, deps, app } = await setup();
    const token = sent.tokens[0] as string;
    const empty = await call(app, `/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(empty.status).toBe(400);
    const json = await call(app, `/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "List-Unsubscribe": "One-Click" }),
    });
    expect(json.status).toBe(400);
    const forged = await call(app, `/u/${token.slice(0, -1)}x`, oneClickUrlencoded());
    expect(forged.status).toBe(404);
    expect(await forged.text()).toContain("This link is not valid");
    expect((await contact(sent)).status).toBe("subscribed");
    expect(deps.events).toEqual([]);
  });
});

describe("the preference page", () => {
  it("shows the page for a GET of the unsubscribe URL and does not unsubscribe", async () => {
    const { sent, deps, app } = await setup();
    const token = sent.tokens[0] as string;
    for (const path of [`/u/${token}`, `/u/${token}/preferences`]) {
      const response = await call(app, path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Email preferences");
      expect(html).toContain(sent.recipients[0]?.email);
      expect(html).toContain('name="list"');
      expect(html).toContain("Unsubscribe from all");
      expect(html).not.toContain("<script");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
    }
    expect((await contact(sent)).status).toBe("subscribed");
    expect(deps.events).toEqual([]);
  });

  it("shows one generic message for an invalid or forged token", async () => {
    const { sent, app } = await setup();
    const token = sent.tokens[0] as string;
    for (const path of ["/u/test", `/u/${token.slice(0, -1)}x`, `/u/${token}x/preferences`]) {
      const response = await call(app, path);
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("This link is not valid");
      expect(html).not.toContain(sent.recipients[0]?.email);
    }
  });

  it("confirms an unsubscribe from all, then offers to subscribe again", async () => {
    const { sent, deps, app } = await setup();
    const token = sent.tokens[0] as string;
    const confirm = await call(app, `/u/${token}/preferences?step=confirm-all`);
    expect(await confirm.text()).toContain("Unsubscribe from all emails?");
    // The confirmation page alone changes nothing.
    expect((await contact(sent)).status).toBe("subscribed");

    const done = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, { action: "unsubscribe_all" }),
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`/u/${token}/preferences?state=unsubscribed`);
    const after = await contact(sent);
    expect(after.status).toBe("unsubscribed");
    expect(after.unsubscribeSource).toBe("preference_page");
    expect(deps.events).toHaveLength(1);

    const page = await (await call(app, `/u/${token}/preferences?state=unsubscribed`)).text();
    expect(page).toContain("You are unsubscribed");
    expect(page).toContain("Subscribe again");
    const already = await (await call(app, `/u/${token}`)).text();
    expect(already).toContain("You are already unsubscribed");

    const again = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, { action: "resubscribe" }),
    );
    expect(again.headers.get("location")).toBe(`/u/${token}/preferences?state=resubscribed`);
    const back = await contact(sent);
    expect(back.status).toBe("subscribed");
    expect(back.lists[0]?.status).toBe("subscribed");
    expect(await (await call(app, `/u/${token}/preferences?state=resubscribed`)).text()).toContain(
      "You are subscribed again.",
    );
  });

  it("saves list choices", async () => {
    const { sent, deps, app } = await setup();
    const token = sent.tokens[0] as string;
    const saved = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, { action: "save" }),
    );
    expect(saved.headers.get("location")).toBe(`/u/${token}/preferences?state=saved`);
    const left = await contact(sent);
    expect(left.lists[0]).toMatchObject({ status: "unsubscribed", source: "preference_page" });
    // Leaving a list is not an unsubscribe from all.
    expect(left.status).toBe("subscribed");
    expect(deps.events).toHaveLength(1);
    await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, { action: "save", list: String(sent.seeded.listId) }),
    );
    expect((await contact(sent)).lists[0]?.status).toBe("subscribed");
  });

  it("refuses a form without the form token or from another site", async () => {
    const { sent, app } = await setup();
    const token = sent.tokens[0] as string;
    const noToken = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, { action: "unsubscribe_all" }, "0".repeat(32)),
    );
    expect(noToken.status).toBe(403);
    const crossSite = await formPost(token, { action: "unsubscribe_all" });
    const response = await call(app, `/u/${token}/preferences`, {
      ...crossSite,
      headers: {
        ...crossSite.headers,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(response.status).toBe(403);
    // Another recipient's form token does not work either.
    const other = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(
        token,
        { action: "unsubscribe_all" },
        await formToken(SIGNING, sent.tokens[1] as string),
      ),
    );
    expect(other.status).toBe(403);
    expect((await contact(sent)).status).toBe("subscribed");
  });
});
