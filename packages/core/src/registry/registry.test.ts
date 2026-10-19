import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isScope } from "../scopes";
import {
  createRegistry,
  defineOperation,
  mcpToolName,
  type Operation,
  registry,
  validateOperation,
} from ".";

function op(overrides: Partial<Operation> = {}): Operation {
  return defineOperation({
    id: "things.get",
    summary: "Get a thing",
    method: "get",
    path: "/things/{id}",
    scope: "contacts:read",
    risk: "read",
    mcp: { class: "now", reason: "Agents read things." },
    input: z.object({ id: z.coerce.number() }),
    output: z.object({ id: z.number() }),
    handler: async (input) => ({ id: input.id }),
    ...overrides,
  } as Operation);
}

describe("operation registry", () => {
  it("gives every entry a method, a path, a scope, a risk class, and an MCP classification", () => {
    expect(registry.operations.length).toBeGreaterThan(0);
    for (const operation of registry.operations) {
      expect(validateOperation(operation), operation.id).toEqual([]);
      expect(isScope(operation.scope), operation.id).toBe(true);
      expect(["now", "later", "never"], operation.id).toContain(operation.mcp.class);
      expect(operation.mcp.reason.trim().length, operation.id).toBeGreaterThan(0);
    }
  });

  it("keeps operation ids unique and finds each operation by id", () => {
    const ids = registry.operations.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(registry.get(id)?.id).toBe(id);
    expect(registry.get("nothing.here")).toBeUndefined();
  });

  it("rejects an operation without an MCP classification", () => {
    const missing = op({ mcp: undefined as unknown as Operation["mcp"] });
    expect(() => createRegistry([missing])).toThrow(/MCP classification/);
  });

  it("rejects an MCP classification without a reason", () => {
    expect(() => createRegistry([op({ mcp: { class: "never", reason: "  " } })])).toThrow(
      /no reason/,
    );
  });

  it("rejects an unknown scope", () => {
    expect(() => createRegistry([op({ scope: "everything" as Operation["scope"] })])).toThrow(
      /unknown scope/,
    );
  });

  it("rejects a path parameter that is not in the input", () => {
    expect(() => createRegistry([op({ input: z.object({}) })])).toThrow(/path parameter "id"/);
  });

  it("rejects duplicate ids and duplicate routes", () => {
    expect(() => createRegistry([op(), op()])).toThrow(/Duplicate operation id/);
    expect(() =>
      createRegistry([
        op(),
        op({
          id: "things.read",
          input: z.object({ thingId: z.string() }),
          path: "/things/{thingId}",
        }),
      ]),
    ).toThrow(/Duplicate route/);
  });

  it("rejects a malformed id or path", () => {
    expect(() => createRegistry([op({ id: "Things" })])).toThrow(/area.verb/);
    expect(() => createRegistry([op({ path: "things" })])).toThrow(/path is not valid/);
  });

  it("names MCP tools after the id, or after a valid override, and keeps the names unique", () => {
    expect(mcpToolName(op())).toBe("things_get");
    expect(mcpToolName(op({ mcp: { class: "now", reason: "r", tool: "get_thing" } }))).toBe(
      "get_thing",
    );
    expect(() =>
      createRegistry([op({ mcp: { class: "now", reason: "r", tool: "Get-Thing" } })]),
    ).toThrow(/tool name is not valid/);
    expect(() =>
      createRegistry([
        op(),
        op({
          id: "things.list",
          path: "/things",
          input: z.object({}),
          mcp: { class: "now", reason: "r", tool: "things_get" },
        }),
      ]),
    ).toThrow(/Duplicate MCP tool name/);
  });
});
