import { createHash } from "node:crypto";
import { renderEmail } from "@envelopen/email-render/render";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { documentFromJSON } from "./doc";
import { editorExtensions } from "./extensions";
import { TEMPLATE_FIXTURES } from "./template-fixtures";
import V03 from "./template-fixtures.v03.json";

// R24: the builder (U14) opens every existing template unchanged, and it renders to the
// same bytes as before. The SHA-256 values come from the v0.3 renderer, before U14.
// template-fixtures.v03.json holds that HTML and text, for the e2e test (editor.spec.ts).

const EXPECTED: Record<string, [html: string, text: string]> = {
  "starter document": [
    "eaea278b523c06f831e8d748ab7a9269ee016dd64116b63035916bb747d885aa",
    "79d796a59f0eb5ae434f5877128cba58df2ed3179a0120065c5c254a89043498",
  ],
  "origin block set": [
    "5f50ca1097731e6c4b4cb8bc872a8f191b4133628c8ed0a8b8f757b651488b54",
    "56f02c30217cea7bb02531d969472f57a378ae56b8131ddd0484ee59da708ead",
  ],
  "monthly newsletter": [
    "9cfabd6f4de67a654fb4d4b5b0bcf915c2a77c91762f00ffaf83e14530fa72af",
    "32ac60a2fd86bed5fba882a11816a5dba46c121af2e6754bfeefcb670147a721",
  ],
  "product announcement": [
    "597982cc4cd0804bce5a36af7fdcb6d80f89127aecdffc131e4f9cdaa32833f6",
    "b1cca090bd3a6c1e6704e12aa9efaa0c80d370b8d33b8240bb1701ee90fc9c1e",
  ],
  "two columns with content": [
    "5766d0b0a1f6339660f4898fce260b687c865ecd9c3a2aff9211c2eca5a19ab8",
    "b075dba87b8dd281ede2ee742ebfb1fcb83ac2ef5be26a29c458b8d291271801",
  ],
  // U13 blocks (unreleased). U15 writes the brand name and social links in
  // `brand.color_primary_text`, so a light primary color stays readable.
  "brand blocks and brand font": [
    "289763b58adb71fe9e3e80103b7b3cccadd97d7508651c92670f51021debd5ad",
    "b63739adbc114ea66f3f44b398aa36530f1d640e499f65b6d8aeb94f767301c5",
  ],
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const schema = getSchema(editorExtensions());

describe("existing templates in the builder (R24)", () => {
  it("has an expected hash and the v0.3 HTML for every fixture", () => {
    const names = TEMPLATE_FIXTURES.map((fixture) => fixture.name).sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
    expect(names).toEqual(Object.keys(V03).sort());
    for (const [name, rendered] of Object.entries(V03)) {
      expect([sha(rendered.html), sha(rendered.text)], name).toEqual(EXPECTED[name]);
    }
  });

  for (const fixture of TEMPLATE_FIXTURES) {
    it(`opens "${fixture.name}" and renders the same bytes before an edit`, async () => {
      // The editor schema accepts the document as it is: nothing is dropped or fixed.
      const node = schema.nodeFromJSON(fixture.doc);
      node.check();
      const opened = documentFromJSON(node.toJSON());
      expect(opened.content.map((block) => block.type)).toEqual(
        fixture.doc.content.map((block) => block.type),
      );
      expect(schema.nodeFromJSON(opened).eq(node)).toBe(true);

      const [html, text] = EXPECTED[fixture.name] ?? ["", ""];
      const before = await renderEmail(fixture.doc, { preheader: "Preheader" });
      const after = await renderEmail(opened, { preheader: "Preheader" });
      expect(sha(before.html)).toBe(html);
      expect(sha(before.text)).toBe(text);
      expect(after.html).toBe(before.html);
      expect(after.text).toBe(before.text);
    });
  }
});
