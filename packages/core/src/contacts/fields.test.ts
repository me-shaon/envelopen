import type { DbConnection } from "@envelopen/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  type TestServices,
  testDb,
  testServices,
} from "../../test/fixtures";
import { customFieldValues } from "../campaigns/batch";
import { isOperationError, type OperationError } from "../errors";
import { runOperation } from "../executor";
import { buildContactsCsv } from "../import/export";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../principal";
import { templatesCreate, templatesPreview } from "../templates/operations";
import {
  fieldsAddOption,
  fieldsCreate,
  fieldsDeleteOption,
  fieldsList,
  fieldsReorderOptions,
  fieldsUpdate,
  fieldsUpdateOption,
} from "./fields";
import { contactsGet, contactsUpdate, contactsUpsert } from "./operations";

// Choice custom fields (U7, R13).

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

async function owner(name = "Fields") {
  const db = testDb();
  const userId = await createUser(db);
  const workspaceId = await createOwnedWorkspace(db, userId, name);
  return { db, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

function run<O = Record<string, unknown>>(
  db: DbConnection,
  principal: Principal,
  operation: Parameters<typeof runOperation>[1],
  input: unknown,
) {
  return runOperation(principal, operation, input, { db, services }) as Promise<O>;
}

async function rejection(promise: Promise<unknown>): Promise<OperationError> {
  try {
    await promise;
  } catch (error) {
    if (isOperationError(error)) return error;
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

interface Field {
  id: number;
  key: string;
  label: string;
  type: string;
  options: { id: number; label: string; position: number }[];
}

interface Contact {
  id: number;
  fields: Record<string, string | null>;
}

async function interests(db: DbConnection, principal: Principal) {
  const field = await run<Field>(db, principal, fieldsCreate, {
    key: "interests",
    label: "Interests",
    type: "multi",
    options: ["Design", "Data", "Writing"],
  });
  const [design, data, writing] = field.options.map((option) => option.id) as [
    number,
    number,
    number,
  ];
  return { field, design, data, writing };
}

async function preview(db: DbConnection, principal: Principal, contactId: number) {
  const template = await run<{ id: number }>(db, principal, templatesCreate, {
    name: `Interests ${crypto.randomUUID()}`,
    subject: "About {{ interests }}",
    format: "html",
    source: '<p>You like {{ interests | default: "nothing yet" }}.</p>',
  });
  return run<{ subject: string; html: string }>(db, principal, templatesPreview, {
    id: template.id,
    contactId,
  });
}

describe("choice custom fields (R13)", () => {
  it("creates a multiple choice field, sets two options, and prints the labels in a merge tag", async () => {
    const { db, principal, workspaceId } = await owner();
    const { field, design, writing } = await interests(db, principal);
    expect(field).toMatchObject({ key: "interests", label: "Interests", type: "multi" });
    expect(field.options.map((option) => [option.label, option.position])).toEqual([
      ["Design", 0],
      ["Data", 1],
      ["Writing", 2],
    ]);

    // By option id and by label, without regard to case.
    const upsert = await run<{ contact: Contact }>(db, principal, contactsUpsert, {
      email: "ana@example.com",
      fields: { interests: [writing, "design"] },
    });
    expect(upsert.contact.fields.interests).toBe(JSON.stringify([design, writing]));

    const shown = await preview(db, principal, upsert.contact.id);
    expect(shown.subject).toBe("About Design, Writing");
    expect(shown.html).toContain("<p>You like Design, Writing.</p>");

    // The send path prints the same labels.
    const values = await customFieldValues(db, workspaceId, [upsert.contact.id], ["interests"]);
    expect(values.get(upsert.contact.id)).toEqual({ interests: "Design, Writing" });

    // A text value with commas, and a single choice by id in text.
    await run(db, principal, fieldsCreate, {
      key: "plan",
      label: "Plan",
      type: "choice",
      options: ["Free", "Pro"],
    });
    const list = await run<{ items: Field[] }>(db, principal, fieldsList, {});
    const plan = list.items.find((item) => item.key === "plan") as Field;
    const pro = plan.options[1]?.id as number;
    const updated = await run<Contact>(db, principal, contactsUpdate, {
      id: upsert.contact.id,
      fields: { interests: "Data, writing", plan: String(pro) },
    });
    expect(updated.fields.plan).toBe(String(pro));
    expect(JSON.parse(updated.fields.interests as string)).toHaveLength(2);

    // An empty list clears the value, so the fallback shows.
    await run(db, principal, contactsUpdate, { id: upsert.contact.id, fields: { interests: [] } });
    expect((await preview(db, principal, upsert.contact.id)).html).toContain("nothing yet");
  });

  it("renames an option without touching the stored values", async () => {
    const { db, principal, workspaceId } = await owner();
    const { field, design } = await interests(db, principal);
    const upsert = await run<{ contact: Contact }>(db, principal, contactsUpsert, {
      email: "bo@example.com",
      fields: { interests: ["Design"] },
    });
    const stored = upsert.contact.fields.interests;

    const renamed = await run<Field>(db, principal, fieldsUpdateOption, {
      id: field.id,
      optionId: design,
      label: "Product design",
    });
    expect(renamed.options[0]).toMatchObject({ id: design, label: "Product design" });
    const contact = await run<Contact>(db, principal, contactsGet, { id: upsert.contact.id });
    expect(contact.fields.interests).toBe(stored);
    expect((await preview(db, principal, contact.id)).html).toContain(
      "<p>You like Product design.</p>",
    );

    // A label that another option has, in any case, is refused. So is a comma.
    const taken = await rejection(
      run(db, principal, fieldsUpdateOption, { id: field.id, optionId: design, label: "DATA" }),
    );
    expect(taken.code).toBe("conflict");
    const comma = await rejection(
      run(db, principal, fieldsAddOption, { id: field.id, label: "Tea, coffee" }),
    );
    expect(comma.code).toBe("invalid_input");

    // Add, reorder, and rename the field. The CSV export prints labels.
    const added = await run<Field>(db, principal, fieldsAddOption, {
      id: field.id,
      label: "Music",
    });
    expect(added.options.map((option) => option.label)).toEqual([
      "Product design",
      "Data",
      "Writing",
      "Music",
    ]);
    const reordered = await run<Field>(db, principal, fieldsReorderOptions, {
      id: field.id,
      optionIds: [...added.options].reverse().map((option) => option.id),
    });
    expect(reordered.options.map((option) => option.label)).toEqual([
      "Music",
      "Writing",
      "Data",
      "Product design",
    ]);
    const partial = await rejection(
      run(db, principal, fieldsReorderOptions, { id: field.id, optionIds: [design] }),
    );
    expect(partial.code).toBe("invalid_input");
    await run(db, principal, fieldsUpdate, { id: field.id, label: "Topics" });
    await run(db, principal, contactsUpdate, {
      id: contact.id,
      fields: { interests: ["Data", "Product design"] },
    });
    const { csv } = await buildContactsCsv(db.db, workspaceId, {});
    expect(csv.split("\r\n")[0]).toMatch(/,interests$/);
    // Option order: Data comes before Product design after the reorder.
    expect(csv).toContain('"Data, Product design"');
  });

  it("refuses to delete an option in use with the count, and merges it into another option", async () => {
    const { db, principal } = await owner();
    const { field, design, data, writing } = await interests(db, principal);
    const ids: number[] = [];
    for (const [email, value] of [
      ["a@example.com", ["Design"]],
      ["b@example.com", ["Design", "Data"]],
      ["c@example.com", ["Writing"]],
    ] as const) {
      const result = await run<{ contact: Contact }>(db, principal, contactsUpsert, {
        email,
        fields: { interests: [...value] },
      });
      ids.push(result.contact.id);
    }

    const refused = await rejection(
      run(db, principal, fieldsDeleteOption, { id: field.id, optionId: design }),
    );
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("2 contacts hold the option");
    expect(refused.details).toEqual({ contacts: 2 });

    const self = await rejection(
      run(db, principal, fieldsDeleteOption, { id: field.id, optionId: design, mergeInto: design }),
    );
    expect(self.code).toBe("invalid_input");

    const merged = await run<Field & { merged: number }>(db, principal, fieldsDeleteOption, {
      id: field.id,
      optionId: design,
      mergeInto: data,
    });
    expect(merged.merged).toBe(2);
    expect(merged.options.map((option) => option.id)).toEqual([data, writing]);
    const values = await Promise.all(
      ids.map(async (id) => (await run<Contact>(db, principal, contactsGet, { id })).fields),
    );
    // No duplicate when the contact held both options.
    expect(values.map((value) => value.interests)).toEqual([
      JSON.stringify([data]),
      JSON.stringify([data]),
      JSON.stringify([writing]),
    ]);

    // A single choice merges too. An option that no contact holds deletes at once.
    const plan = await run<Field>(db, principal, fieldsCreate, {
      key: "plan",
      label: "Plan",
      type: "choice",
      options: ["Free", "Pro", "Team"],
    });
    const [free, pro, team] = plan.options.map((option) => option.id) as [number, number, number];
    await run(db, principal, contactsUpdate, { id: ids[0], fields: { plan: "Team" } });
    const one = await rejection(
      run(db, principal, fieldsDeleteOption, { id: plan.id, optionId: team }),
    );
    expect(one.message).toContain("1 contact holds the option");
    await run(db, principal, fieldsDeleteOption, { id: plan.id, optionId: team, mergeInto: pro });
    const contact = await run<Contact>(db, principal, contactsGet, { id: ids[0] });
    expect(contact.fields.plan).toBe(String(pro));
    const after = await run<Field & { merged: number }>(db, principal, fieldsDeleteOption, {
      id: plan.id,
      optionId: free,
    });
    expect(after.merged).toBe(0);
    expect(after.options.map((option) => option.label)).toEqual(["Pro"]);
  });

  it("rejects unknown and forged option ids, and options of another field or workspace", async () => {
    const { db, principal } = await owner();
    const { field } = await interests(db, principal);
    const plan = await run<Field>(db, principal, fieldsCreate, {
      key: "plan",
      label: "Plan",
      type: "choice",
      options: ["Free", "Pro"],
    });
    const other = await owner("Other");
    const foreign = await run<Field>(other.db, other.principal, fieldsCreate, {
      key: "interests",
      label: "Interests",
      type: "multi",
      options: ["Secret"],
    });
    const foreignId = foreign.options[0]?.id as number;
    const planOption = plan.options[0]?.id as number;

    const cases: unknown[] = [
      { interests: [foreignId] },
      { interests: [String(foreignId)] },
      { interests: [planOption] },
      { interests: ["Cooking"] },
      { plan: foreign.options[0]?.id },
      { plan: ["Free", "Pro"] },
      { course: ["a", "b"] },
    ];
    for (const fields of cases) {
      const error = await rejection(
        run(db, principal, contactsUpsert, { email: "forged@example.com", fields }),
      );
      expect({ fields, code: error.code }).toEqual({ fields, code: "invalid_input" });
    }
    // Nothing was written: no contact, and no text field "course".
    const list = await run<{ items: Field[] }>(db, principal, fieldsList, {});
    expect(list.items.map((item) => item.key)).toEqual(["interests", "plan"]);

    // Another workspace cannot change these options.
    const missing = await rejection(
      run(other.db, other.principal, fieldsUpdateOption, {
        id: field.id,
        optionId: field.options[0]?.id,
        label: "Mine",
      }),
    );
    expect(missing.code).toBe("not_found");
    // An option of another field is not found in this field.
    const wrong = await rejection(
      run(db, principal, fieldsDeleteOption, { id: field.id, optionId: planOption }),
    );
    expect(wrong.code).toBe("not_found");
  });

  it("checks keys, types, and scopes when it creates a field", async () => {
    const { db, principal, workspaceId } = await owner();
    await interests(db, principal);
    expect(
      (
        await rejection(
          run(db, principal, fieldsCreate, { key: "interests", label: "Again", type: "text" }),
        )
      ).code,
    ).toBe("conflict");
    expect(
      (
        await rejection(
          run(db, principal, fieldsCreate, {
            key: "Bad Key",
            label: "Bad",
            type: "choice",
            options: ["A"],
          }),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await rejection(
          run(db, principal, fieldsCreate, {
            key: "notes",
            label: "Notes",
            type: "text",
            options: ["A"],
          }),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await rejection(
          run(db, principal, fieldsCreate, {
            key: "size",
            label: "Size",
            type: "choice",
            options: ["S", "s"],
          }),
        )
      ).code,
    ).toBe("invalid_input");
    const text = await run<Field>(db, principal, fieldsCreate, {
      key: "notes",
      label: "Notes",
      type: "text",
    });
    expect(text).toMatchObject({ type: "text", options: [] });
    expect(
      (await rejection(run(db, principal, fieldsAddOption, { id: text.id, label: "A" }))).code,
    ).toBe("invalid_input");

    // An API key with contacts:read lists the fields but cannot change them.
    const reader = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:read"],
      surface: "rest",
    });
    const list = await run<{ items: Field[] }>(db, reader, fieldsList, {});
    expect(list.items).toHaveLength(2);
    expect(
      (await rejection(run(db, reader, fieldsCreate, { key: "x", label: "X", type: "text" }))).code,
    ).toBe("forbidden");
  });
});
