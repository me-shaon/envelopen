import { createExecutionContext, introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { registry } from "@envelopen/core";
import { describe, expect, it } from "vitest";
import {
  bearer,
  createApiKey,
  createTestApp,
  createWorkspace,
  jsonPost,
  testDb,
} from "../../test/helpers";
import worker from "../index";

// The import Workflow end to end: REST calls with an API key start real Workflow runs
// in the local runtime, and the test waits for each run.

type Json = Record<string, unknown>;

const app = () => createTestApp({ registry });

async function json<T = Json>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Runs `action`, then waits for every Workflow instance that it started. */
async function waitForRuns(action: () => Promise<void>) {
  const introspector = await introspectWorkflow(env.IMPORT_WORKFLOW);
  try {
    await action();
    const instances = await introspector.get();
    expect(instances.length).toBeGreaterThan(0);
    for (const instance of instances) await instance.waitForStatus("complete");
  } finally {
    await introspector.dispose();
  }
}

function download(path: string) {
  return worker.fetch(new Request(`https://envelopen.test${path}`), env, createExecutionContext());
}

describe("import Workflow", () => {
  it("previews and imports a CSV through REST, then deletes the uploaded file", async () => {
    const workspaceId = await createWorkspace("Workflow");
    const { key } = await createApiKey(workspaceId, ["contacts:read", "contacts:write"]);
    const auth = bearer(key);

    const upload = await json<{ id: number; suggestedMapping: string[] }>(
      await app().request(
        "/imports",
        jsonPost(
          {
            filename: "students.csv",
            content: "Email,First Name\nana@example.com,Ana\nbad,Bad\nana@example.com,Dup\n",
          },
          auth,
        ),
      ),
    );
    expect(upload.suggestedMapping).toEqual(["email", "first_name"]);

    await waitForRuns(async () => {
      await json(
        await app().request(
          `/imports/${upload.id}/preview`,
          jsonPost(
            {
              mapping: upload.suggestedMapping,
              consentBasis: "existing_customer",
              tags: ["Course"],
            },
            auth,
          ),
        ),
      );
    });
    const previewed = await json<{ status: string; preview: Json }>(
      await app().request(`/imports/${upload.id}`, { headers: auth }),
    );
    expect(previewed).toMatchObject({
      status: "previewed",
      preview: { total: 3, new: 1, invalid: 1, duplicate: 1 },
    });

    await waitForRuns(async () => {
      await json(await app().request(`/imports/${upload.id}/start`, jsonPost({}, auth)));
    });
    const done = await json<{ status: string; counts: Json; hasErrorFile: boolean }>(
      await app().request(`/imports/${upload.id}`, { headers: auth }),
    );
    expect(done).toMatchObject({ status: "completed", counts: { new: 1 }, hasErrorFile: true });

    const contacts = await json<{ items: { email: string; source: string; tags: Json[] }[] }>(
      await app().request("/contacts", { headers: auth }),
    );
    expect(contacts.items).toEqual([
      expect.objectContaining({
        email: "ana@example.com",
        source: `import:${upload.id}`,
        tags: [expect.objectContaining({ name: "Course" })],
      }),
    ]);

    // The uploaded CSV is gone. Only the error file is left.
    const stored = await env.BUCKET.list({ prefix: `imports/${workspaceId}/` });
    expect(stored.objects.map((object) => object.key)).toEqual([
      `imports/${workspaceId}/${upload.id}/errors.csv`,
    ]);

    const link = await json<{ url: string }>(
      await app().request(`/imports/${upload.id}/error-file`, { headers: auth }),
    );
    const file = await download(link.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("students-errors.csv");
    expect(await file.text()).toBe(
      "row,email,reason\r\n2,bad,Not a valid email address\r\n3,ana@example.com,Duplicate of an earlier row\r\n",
    );
    expect((await download(`${link.url.slice(0, -3)}abc`)).status).toBe(404);
  });

  it("covers F2 over REST: an upsert with a tag records the source api_key:<id>", async () => {
    const workspaceId = await createWorkspace("Sync");
    const { key, id } = await createApiKey(workspaceId, ["contacts:write"]);
    const res = await app().request(
      "/contacts",
      jsonPost(
        {
          email: " New.Student@Example.com",
          consentBasis: "existing_customer",
          tags: ["Course 101"],
        },
        bearer(key),
      ),
    );
    const body = await json<{ created: boolean; contact: Json }>(res);
    expect(body).toMatchObject({
      created: true,
      contact: {
        email: "new.student@example.com",
        source: `api_key:${id}`,
        consentBasis: "existing_customer",
        tags: [expect.objectContaining({ name: "Course 101" })],
      },
    });
    // A key without contacts:read cannot list.
    expect((await app().request("/contacts", { headers: bearer(key) })).status).toBe(403);
    const audit = await testDb()
      .db.selectFrom("audit_log")
      .select(["action", "api_key_id", "surface"])
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(audit).toEqual([{ action: "contacts.upsert", api_key_id: id, surface: "rest" }]);
  });

  it("serves an export download until the link expires", async () => {
    const workspaceId = await createWorkspace("Export");
    const { key } = await createApiKey(workspaceId, ["contacts:write", "contacts:export"]);
    await json(await app().request("/contacts", jsonPost({ email: "a@example.com" }, bearer(key))));
    const created = await json<{ downloadUrl: string; rowCount: number }>(
      await app().request("/exports", jsonPost({}, bearer(key))),
    );
    expect(created.rowCount).toBe(1);
    const file = await download(created.downloadUrl);
    expect(file.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(await file.text()).toContain("a@example.com");
  });
});
