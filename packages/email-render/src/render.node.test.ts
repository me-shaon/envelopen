import { describe, expect, it } from "vitest";
import { BLOCK_TYPES, type BlockNode, defaultBlock, type EmailDocument } from "./blocks/types";
import { renderBlocks, renderEmail } from "./render";

// The renderer runs in the browser at save time (KTD26). These tests run it in Node.

const SAVED_BLOCK: BlockNode[] = [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Office hours" }] },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "Every Tuesday, " },
      { type: "text", text: "5 pm", marks: [{ type: "bold" }] },
      { type: "text", text: ". " },
      {
        type: "text",
        text: "Join",
        marks: [{ type: "link", attrs: { href: "https://x.io/join" } }],
      },
    ],
  },
  {
    type: "button",
    attrs: {
      label: "Book a slot",
      href: "https://x.io/book",
      align: "center",
      background: "#8fb2b0",
      color: "#141312",
    },
  },
];

function doc(...content: BlockNode[]): EmailDocument {
  return { type: "doc", content };
}

function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  return html.slice(from, html.indexOf(end, from) + end.length);
}

describe("renderEmail", () => {
  it("renders every block of the origin block set", async () => {
    const { html, text } = await renderEmail(doc(...BLOCK_TYPES.map(defaultBlock)), {
      preheader: "Preheader text",
    });
    expect(html.startsWith("<!DOCTYPE html")).toBe(true);
    expect(html).toContain("A clear heading</span></h2>");
    expect(html).toContain("Write something here.");
    expect(html).toContain(">Read more<");
    expect(html).toContain('class="env-hr"');
    expect(html).toContain('class="env-col"');
    expect(html).toContain(">Website</a>");
    expect(html).toContain('href="{{ unsubscribe_url }}"');
    expect(html).toContain('href="{{ preferences_url }}"');
    expect(html).toContain("Preheader text");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(text).toContain("Unsubscribe {{ unsubscribe_url }}");
  });

  it("writes merge tag nodes as tags with fallbacks, in both parts", async () => {
    const { html, text } = await renderEmail(
      doc({
        type: "heading",
        attrs: { level: 1 },
        content: [
          { type: "text", text: "Hi " },
          { type: "mergeTag", attrs: { field: "first_name", fallback: "there" } },
        ],
      }),
    );
    expect(html).toContain("<span>Hi </span>{{ first_name | default: &quot;there&quot; }}</h1>");
    expect(text).toContain('Hi {{ first_name | default: "there" }}');
  });

  it("renders the same document to the same bytes", async () => {
    const value = doc(...SAVED_BLOCK, defaultBlock("columns"), defaultBlock("footer"));
    const first = await renderEmail(value, { preheader: "p" });
    const second = await renderEmail(structuredClone(value), { preheader: "p" });
    expect(second.html).toBe(first.html);
    expect(second.text).toBe(first.text);
  });

  it("renders a saved block inserted into a second template the same", async () => {
    const intro: BlockNode = {
      type: "paragraph",
      content: [{ type: "text", text: "Welcome to the course." }],
    };
    const first = await renderEmail(doc(...structuredClone(SAVED_BLOCK), defaultBlock("footer")));
    const second = await renderEmail(
      doc(intro, defaultBlock("divider"), ...structuredClone(SAVED_BLOCK), defaultBlock("footer")),
    );
    const block = await renderBlocks(SAVED_BLOCK);
    const start = "<h2";
    const end = "Book a slot</span>";
    expect(between(first.html, start, end)).toBe(between(second.html, start, end));
    expect(between(block, start, end)).toBe(between(first.html, start, end));
  });

  it("skips an image without a source and clamps sizes", async () => {
    const { html } = await renderEmail(
      doc(
        { type: "image", attrs: { src: "", alt: "", width: 600, href: "", align: "left" } },
        { type: "spacer", attrs: { height: 10_000 } },
      ),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("height:160px");
  });
});
