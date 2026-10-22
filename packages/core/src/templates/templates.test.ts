import type { DbConnection } from "@envelopen/db";
import { toSendFixtures } from "@envelopen/providers/conformance/fixtures/tosend";
import { mockFetch } from "@envelopen/providers/conformance/mock-fetch";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  insertContact,
  type TestServices,
  testDb,
  testServices,
} from "../../test/fixtures";
import { connectionsCreate } from "../connections/operations";
import { campaignsSendTest } from "../connections/test-send";
import { runOperation } from "../executor";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../principal";
import {
  savedBlocksCreate,
  savedBlocksDelete,
  savedBlocksList,
  savedBlocksUpdate,
  templatesCreate,
  templatesDelete,
  templatesDuplicate,
  templatesGet,
  templatesList,
  templatesMergeFields,
  templatesPreview,
  templatesUpdate,
} from "./operations";

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

async function owner(name = "Templates") {
  const db = testDb();
  const userId = await createUser(db);
  const workspaceId = await createOwnedWorkspace(db, userId, name);
  return { db, userId, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

function run<O = Record<string, unknown>>(
  db: DbConnection,
  principal: Principal,
  operation: Parameters<typeof runOperation>[1],
  input: unknown,
  extra: { services?: TestServices } = {},
) {
  return runOperation(principal, operation, input, {
    db,
    services: extra.services ?? services,
  }) as Promise<O>;
}

interface Template {
  id: number;
  name: string;
  format: string;
  source: string;
  html: string;
  text: string;
  subject: string | null;
  editorVersion: number | null;
  mergeTags: string[];
  links: string[];
}

const BLOCK_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
});
const BLOCK_HTML =
  "<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body><p>Hi {{ first_name | default: &quot;there&quot; }}</p>" +
  '<a href="https://example.com/a">A</a><a href="{{ unsubscribe_url }}">Unsubscribe</a></body></html>';

describe("templates (R26 to R29, R69)", () => {
  it("stores API HTML without script or event handlers (KTD27)", async () => {
    const { db, workspaceId } = await owner();
    const key = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 5,
      scopes: ["templates:write", "campaigns:read"],
      surface: "rest",
    });
    const created = await run<Template>(db, key, templatesCreate, {
      name: "From the API",
      subject: "Hello {{ first_name }}",
      format: "html",
      source:
        '<p onclick="steal()">Hello</p><script>alert(1)</script><img src="x" onerror="alert(1)">' +
        '<a href="javascript:alert(1)">bad</a><a href="https://example.com/ok">ok</a>',
    });
    for (const value of [created.source, created.html]) {
      expect(value).not.toMatch(/script|onerror|onclick|javascript:/i);
    }
    expect(created.html).toBe('<p>Hello</p><img><a>bad</a><a href="https://example.com/ok">ok</a>');
    expect(created.text).toBe("Hello\n\nbadok (https://example.com/ok)");
    expect(created.mergeTags).toEqual(["first_name"]);
    expect(created.links).toEqual(["https://example.com/ok"]);
    const row = await db.db
      .selectFrom("templates")
      .select(["source", "html"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(`${row.source}${row.html}`).not.toMatch(/script|onerror/i);
  });

  it("renders a Markdown template into the email frame and keeps merge tags", async () => {
    const { db, principal } = await owner();
    const created = await run<Template>(db, principal, templatesCreate, {
      name: "Markdown",
      preheader: "This week",
      format: "markdown",
      source:
        '# Hi {{ first_name | default: "there" }}\n\n<img src=x onerror=alert(1)>\n\n[Unsubscribe]({{ unsubscribe_url }})',
    });
    expect(created.html).toContain("<h1>Hi {{ first_name | default: &quot;there&quot; }}</h1>");
    expect(created.html).toContain('<a href="{{ unsubscribe_url }}">Unsubscribe</a>');
    expect(created.html).toContain("This week");
    expect(created.html).not.toContain("onerror");
    expect(created.text).toContain("# Hi {{ first_name");
    expect(created.editorVersion).toBeNull();
  });

  it("stores the editor JSON with the sanitized HTML for a block template", async () => {
    const { db, principal } = await owner();
    await expect(
      run(db, principal, templatesCreate, { name: "B", format: "blocks", source: BLOCK_DOC }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      run(db, principal, templatesCreate, {
        name: "B",
        format: "blocks",
        source: '{"type":"doc","content":[{"type":"evil"}]}',
        html: BLOCK_HTML,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const created = await run<Template>(db, principal, templatesCreate, {
      name: "Blocks",
      format: "blocks",
      source: BLOCK_DOC,
      html: `${BLOCK_HTML}<script>x</script>`,
      text: "Hi there",
    });
    expect(JSON.parse(created.source)).toEqual(JSON.parse(BLOCK_DOC));
    expect(created.html).toBe(BLOCK_HTML);
    expect(created.text).toBe("Hi there");
    expect(created.editorVersion).toBe(1);
  });

  it("updates, duplicates, lists, and deletes", async () => {
    const { db, principal } = await owner();
    const created = await run<Template>(db, principal, templatesCreate, {
      name: "Weekly",
      format: "blocks",
      source: BLOCK_DOC,
      html: BLOCK_HTML,
    });
    await expect(
      run(db, principal, templatesUpdate, { id: created.id, source: BLOCK_DOC }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const renamed = await run<Template>(db, principal, templatesUpdate, {
      id: created.id,
      name: "Weekly news",
      subject: "Week {{ week }}",
    });
    expect(renamed).toMatchObject({ name: "Weekly news", html: created.html });
    const changed = await run<Template>(db, principal, templatesUpdate, {
      id: created.id,
      source: BLOCK_DOC,
      html: '<p onmouseover="x()">New</p>',
    });
    expect(changed.html).toBe("<p>New</p>");
    expect(changed.text).toBe("New");

    const copy = await run<Template>(db, principal, templatesDuplicate, { id: created.id });
    expect(copy).toMatchObject({ name: "Copy of Weekly news", html: "<p>New</p>" });
    expect(copy.id).not.toBe(created.id);

    const list = await run<{ items: { id: number }[] }>(db, principal, templatesList, {});
    expect(list.items.map((item) => item.id)).toEqual([copy.id, created.id]);

    await run(db, principal, templatesDelete, { id: created.id });
    await expect(run(db, principal, templatesGet, { id: created.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("keeps templates inside their workspace", async () => {
    const first = await owner("One");
    const second = await owner("Two");
    const created = await run<Template>(first.db, first.principal, templatesCreate, {
      name: "Private",
      format: "html",
      source: "<p>x</p>",
    });
    for (const operation of [templatesGet, templatesPreview, templatesDuplicate, templatesDelete]) {
      await expect(
        run(second.db, second.principal, operation, { id: created.id }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("needs templates:write to change a template", async () => {
    const { db, workspaceId } = await owner();
    const reader = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 9,
      scopes: ["campaigns:read"],
      surface: "rest",
    });
    await expect(
      run(db, reader, templatesCreate, { name: "x", format: "html", source: "<p>x</p>" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(run(db, reader, templatesList, {})).resolves.toMatchObject({ items: [] });
  });

  it("previews with sample values or a contact, with fallbacks and missing tags", async () => {
    const { db, principal, workspaceId } = await owner();
    const created = await run<Template>(db, principal, templatesCreate, {
      name: "Preview",
      subject: "Hi {{ first_name }}",
      format: "html",
      source:
        '<p>Hi {{ first_name | default: "there" }} from {{ course }}</p><a href="{{ unsubscribe_url }}">u</a>',
    });
    const sample = await run<{ subject: string; html: string; missing: string[] }>(
      db,
      principal,
      templatesPreview,
      { id: created.id },
    );
    expect(sample.subject).toBe("Hi Ada");
    expect(sample.html).toBe('<p>Hi Ada from </p><a href="https://envelopen.test/u/test">u</a>');
    expect(sample.missing).toEqual(["course"]);

    const contact = await insertContact(db, workspaceId, { email: "bo@example.com" });
    const field = await db.db
      .insertInto("contact_fields")
      .values({ workspace_id: workspaceId, key: "course", label: "Course" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db.db
      .insertInto("contact_field_values")
      .values({
        workspace_id: workspaceId,
        contact_id: contact.id,
        field_id: field.id,
        value: "R&D <101>",
      })
      .execute();
    const personal = await run<{ html: string; missing: string[] }>(
      db,
      principal,
      templatesPreview,
      {
        id: created.id,
        contactId: contact.id,
      },
    );
    expect(personal.html).toContain("<p>Hi there from R&amp;D &lt;101&gt;</p>");
    expect(personal.missing).toEqual(["first_name"]);

    const fields = await run<{ items: { key: string; kind: string }[] }>(
      db,
      principal,
      templatesMergeFields,
      {},
    );
    expect(fields.items.map((item) => `${item.kind}:${item.key}`)).toEqual([
      "standard:first_name",
      "standard:last_name",
      "standard:email",
      "custom:course",
      "reserved:unsubscribe_url",
      "reserved:preferences_url",
      "brand:brand.name",
      "brand:brand.footer",
      "brand:brand.address",
    ]);
  });

  it("sends a test of a saved template that matches its preview (R30)", async () => {
    const { db, principal, workspaceId, userId } = await owner();
    const connectServices = await testServices({
      fetch: mockFetch([toSendFixtures.info]).fetch,
    });
    await run(
      db,
      principal,
      connectionsCreate,
      {
        provider: "tosend",
        credentials: toSendFixtures.credentials,
      },
      { services: connectServices },
    );
    await db.db
      .insertInto("sending_domains")
      .values({
        workspace_id: workspaceId,
        connection_id: null,
        domain: "mail.example.com",
        tracking_domain: null,
        last_checked_at: Date.now(),
        verified_at: Date.now(),
      })
      .execute();
    const created = await run<Template>(db, principal, templatesCreate, {
      name: "Test me",
      subject: "Hello {{ first_name }}",
      format: "markdown",
      source: 'Hi {{ first_name | default: "there" }}\n\n[Unsubscribe]({{ unsubscribe_url }})',
    });
    const preview = await run<{ html: string; text: string }>(db, principal, templatesPreview, {
      id: created.id,
    });
    const mock = mockFetch([
      {
        label: "toSend batch accepted",
        method: "POST",
        url: "https://api.tosend.com/v2/emails/batch",
        response: { status: 200, body: { results: [{ status: "success", message_id: "ts-1" }] } },
      },
    ]);
    await run(
      db,
      principal,
      campaignsSendTest,
      { to: [`${userId}@example.com`], from: "news@mail.example.com", templateId: created.id },
      { services: await testServices({ fetch: mock.fetch }) },
    );
    const [email] = JSON.parse(mock.calls[0]?.body ?? "{}").emails;
    expect(email.subject).toBe("[Test] Hello Ada");
    expect(email.html).toBe(preview.html);
    expect(email.html).toContain('href="https://envelopen.test/u/test"');

    // A tracking domain carries the links only after its check passes.
    for (const [status, origin] of [
      ["fail", "https://envelopen.test"],
      ["pass", "https://links.example.com"],
    ] as const) {
      await db.db
        .updateTable("sending_domains")
        .set({ tracking_domain: "links.example.com", tracking_status: status })
        .where("workspace_id", "=", workspaceId)
        .where("domain", "=", "mail.example.com")
        .execute();
      await run(
        db,
        principal,
        campaignsSendTest,
        { to: [`${userId}@example.com`], from: "news@mail.example.com", templateId: created.id },
        { services: await testServices({ fetch: mock.fetch }) },
      );
      const [sent] = JSON.parse(mock.calls.at(-1)?.body ?? "{}").emails;
      expect(sent.html).toContain(`href="${origin}/u/test"`);
    }
  });
});

describe("saved blocks (R28)", () => {
  const BLOCKS = JSON.stringify([
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Office hours" }] },
  ]);

  it("creates, lists, renames, and deletes saved blocks per workspace", async () => {
    const { db, principal } = await owner();
    const other = await owner("Other");
    await expect(
      run(db, principal, savedBlocksCreate, { name: "Bad", content: "[]" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      run(db, principal, savedBlocksCreate, { name: "Bad", content: '[{"type":"script"}]' }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const block = await run<{ id: number; html: string | null; content: string }>(
      db,
      principal,
      savedBlocksCreate,
      { name: "Office hours", content: BLOCKS, html: '<h2 onclick="x()">Office hours</h2>' },
    );
    expect(block.html).toBe("<h2>Office hours</h2>");
    expect(JSON.parse(block.content)).toEqual(JSON.parse(BLOCKS));

    const renamed = await run<{ name: string }>(db, principal, savedBlocksUpdate, {
      id: block.id,
      name: "Weekly office hours",
    });
    expect(renamed.name).toBe("Weekly office hours");
    expect(
      (await run<{ items: unknown[] }>(other.db, other.principal, savedBlocksList, {})).items,
    ).toEqual([]);
    await expect(
      run(other.db, other.principal, savedBlocksDelete, { id: block.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await run(db, principal, savedBlocksDelete, { id: block.id });
    expect((await run<{ items: unknown[] }>(db, principal, savedBlocksList, {})).items).toEqual([]);
  });
});
