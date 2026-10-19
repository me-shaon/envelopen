import { API_KEY_SCOPES, isApiKeyScope, mcpToolName, registry } from "@envelopen/core";
import { describe, expect, it } from "vitest";
import committedDocument from "../../web/src/api/openapi.json";
import { buildOpenApiDocument } from "../src/api/router";
import { mcpTools } from "../src/mcp/tools";
import { createApiKey, createWorkspace } from "./helpers";
import { createMcpTestApp } from "./mcp-helpers";

// Agent parity (R66, U16): the registry, the OpenAPI document, and the MCP tool list
// describe the same operations. An operation that skips the registry fails here.

type Json = Record<string, unknown>;

function documentedOperations(document: Json): Map<string, Json> {
  const operations = new Map<string, Json>();
  for (const item of Object.values((document.paths ?? {}) as Record<string, Json>)) {
    for (const operation of Object.values(item as Record<string, Json>)) {
      operations.set(operation.operationId as string, operation);
    }
  }
  return operations;
}

const nowOperations = registry.operations.filter((operation) => operation.mcp.class === "now");

describe("registry, OpenAPI, and MCP parity", () => {
  it("documents every registry operation in OpenAPI, built and committed", () => {
    const ids = registry.operations.map((operation) => operation.id).sort();
    for (const document of [buildOpenApiDocument() as unknown as Json, committedDocument]) {
      const documented = documentedOperations(document as Json);
      expect([...documented.keys()].sort()).toEqual(ids);
      for (const operation of registry.operations) {
        expect(documented.get(operation.id)?.["x-envelopen-mcp"], operation.id).toBe(
          operation.mcp.class,
        );
      }
    }
  });

  it("generates one MCP tool for each operation classified now", () => {
    expect(mcpTools().map((tool) => tool.name)).toEqual(nowOperations.map(mcpToolName));
  });

  it("keeps every now operation reachable with an API key scope", () => {
    for (const operation of nowOperations) {
      expect(isApiKeyScope(operation.scope), operation.id).toBe(true);
    }
  });

  it("lists exactly the now operations to a key with every scope", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, [...API_KEY_SCOPES]);
    const client = await createMcpTestApp().connect(key);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed.sort()).toEqual(nowOperations.map(mcpToolName).sort());
  });
});
