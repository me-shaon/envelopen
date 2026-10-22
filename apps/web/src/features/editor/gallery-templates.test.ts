import { GALLERY_TEMPLATES } from "@envelopen/email-render/gallery";
import { renderEmail } from "@envelopen/email-render/render";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { documentFromJSON } from "./doc";
import { editorExtensions } from "./extensions";

// The gallery templates (U15) open in the builder unchanged: the editor schema accepts
// each document as it is, and the opened document renders the same bytes.

const schema = getSchema(editorExtensions());

describe("gallery templates in the builder", () => {
  for (const template of GALLERY_TEMPLATES) {
    it(`opens "${template.name}" unchanged`, async () => {
      const doc = template.document();
      const node = schema.nodeFromJSON(doc);
      node.check();
      const opened = documentFromJSON(node.toJSON());
      expect(opened.content.map((block) => block.type)).toEqual(
        doc.content.map((block) => block.type),
      );
      expect(schema.nodeFromJSON(opened).eq(node)).toBe(true);
      const before = await renderEmail(doc, { preheader: template.preheader });
      const after = await renderEmail(opened, { preheader: template.preheader });
      expect(after.html).toBe(before.html);
      expect(after.text).toBe(before.text);
    });
  }
});
