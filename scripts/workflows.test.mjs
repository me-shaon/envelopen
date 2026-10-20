// The GitHub workflows run in every deployment's own repository, so a moved tag of a
// third-party action would run there too. Every action must be pinned to a full commit
// SHA, and every workflow must set its token permissions at the top level.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

describe("GitHub workflows", () => {
  it("finds the workflows", () => {
    assert.ok(workflows.includes("ci.yml"));
  });

  for (const name of workflows) {
    const text = readFileSync(join(dir, name), "utf8");

    it(`${name} pins every action to a full commit SHA`, () => {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
      for (const action of uses) {
        // A local action (./path) has no version.
        if (action.startsWith("./")) continue;
        assert.match(action, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name}: ${action}`);
      }
    });

    it(`${name} sets top-level permissions`, () => {
      assert.match(text, /^permissions:/m, name);
    });
  }
});
