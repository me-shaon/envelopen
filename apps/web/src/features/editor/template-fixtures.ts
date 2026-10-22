import {
  BLOCK_TYPES,
  defaultBlock,
  type EmailDocument,
  type ParagraphNode,
  starterDocument,
  type TextNode,
} from "@envelopen/email-render/blocks/types";

// Block documents as v0.1 to v0.3 saved them (R24). The builder (U14) must open each one
// unchanged and render it to the same bytes as before. The newsletter and the
// announcement are the demo templates (scripts/demo.mjs) as block documents.

const FOOTER_TEXT =
  "You get this email because you signed up at example.com.\nAcme Demo, 1 Example Street, Example City.";

const hi: ParagraphNode = {
  type: "paragraph",
  content: [
    { type: "text", text: "Hi " },
    { type: "mergeTag", attrs: { field: "first_name", fallback: "there" } },
    { type: "text", text: "," },
  ],
};

function link(text: string, href: string): TextNode {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] };
}

export const TEMPLATE_FIXTURES: { name: string; doc: EmailDocument }[] = [
  { name: "starter document", doc: starterDocument() },
  {
    name: "origin block set",
    doc: {
      type: "doc",
      // The v0.3 block set: the brand blocks (U13) and the panel (U15) came later.
      content: BLOCK_TYPES.filter(
        (type) => type !== "brandHeader" && type !== "brandFooter" && type !== "panel",
      ).map(defaultBlock),
    },
  },
  {
    name: "monthly newsletter",
    doc: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "The monthly" }] },
        hi,
        { type: "paragraph", content: [{ type: "text", text: "Here is what changed." }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Exports are ten times faster" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Large exports now finish in seconds. " },
            link("Read how we did it", "https://example.com/blog/faster-exports"),
            { type: "text", text: "." },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Office hours on Thursday" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Bring your questions. ", marks: [{ type: "bold" }] },
            { type: "text", text: "We answer ", marks: [{ type: "italic" }] },
            { type: "text", text: "all of them.", marks: [{ type: "underline" }] },
            { type: "hardBreak" },
            link("Save a seat", "https://example.com/events/office-hours"),
          ],
        },
        { type: "footer", attrs: { text: FOOTER_TEXT } },
      ],
    },
  },
  {
    name: "product announcement",
    doc: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Product update" }] },
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Smart segments are here" }],
        },
        hi,
        {
          type: "paragraph",
          content: [{ type: "text", text: "Segments now update themselves." }],
        },
        {
          type: "button",
          attrs: {
            label: "See what is new",
            href: "https://example.com/changelog/smart-segments",
            align: "left",
            background: "#2f6f5e",
            color: "#ffffff",
          },
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Want the details first? " },
            link("Read the guide", "https://example.com/docs/segments"),
          ],
        },
        { type: "footer", attrs: { text: FOOTER_TEXT } },
      ],
    },
  },
  {
    name: "two columns with content",
    doc: {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "https://example.com/banner.png",
            alt: "Banner",
            width: 560,
            href: "https://example.com",
            align: "center",
          },
        },
        {
          type: "columns",
          content: [
            {
              type: "column",
              content: [
                { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Left" }] },
                { type: "paragraph", content: [{ type: "text", text: "The left column." }] },
                {
                  type: "button",
                  attrs: {
                    label: "Book",
                    href: "https://x.io/book",
                    align: "center",
                    background: "#8fb2b0",
                    color: "#141312",
                  },
                },
              ],
            },
            {
              type: "column",
              content: [
                {
                  type: "image",
                  attrs: {
                    src: "https://example.com/side.png",
                    alt: "Side",
                    width: 260,
                    href: "",
                    align: "right",
                  },
                },
                { type: "spacer", attrs: { height: 12 } },
                { type: "html", attrs: { html: "<p>Raw <b>HTML</b></p>" } },
              ],
            },
          ],
        },
        { type: "divider" },
        {
          type: "social",
          attrs: {
            links: [
              { network: "x", url: "https://x.com/acme" },
              { network: "github", url: "https://github.com/acme" },
            ],
            align: "center",
          },
        },
        { type: "footer", attrs: { text: "Acme, 1 Example Street." } },
      ],
    },
  },
  {
    name: "brand blocks and brand font",
    doc: {
      type: "doc",
      attrs: { font: "brand" },
      content: [
        { type: "brandHeader", attrs: { align: "center", showName: true, logoWidth: 160 } },
        {
          type: "button",
          attrs: {
            label: "Shop",
            href: "https://x.io/shop",
            align: "left",
            background: "{{ brand.color_primary }}",
            color: "{{ brand.color_accent }}",
          },
        },
        { type: "brandFooter", attrs: { align: "center", networks: ["x", "github"] } },
      ],
    },
  },
];
