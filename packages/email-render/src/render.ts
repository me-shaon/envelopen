import { plainTextSelectors, render, toPlainText } from "@react-email/render";
import { createElement } from "react";
import { Blocks, EmailTemplate } from "./blocks/render-blocks";
import type { BlockNode, EmailDocument } from "./blocks/types";

// Render in the browser at save time (KTD26). The editor calls `renderEmail` and sends
// the HTML and the text part with the editor JSON. The Worker then only sanitizes
// (KTD27) and, at send time, personalizes with string work. React Email never runs in
// the Worker, so it is not in the Worker bundle.
//
// React's server renderer gives the same bytes for the same input, so a template
// renders the same on every save.

// html-to-text writes headings in upper case by default, which would also turn
// `{{ first_name }}` into `{{ FIRST_NAME }}`.
const TEXT_SELECTORS = [
  ...plainTextSelectors,
  ...["h1", "h2", "h3"].map((selector) => ({ selector, options: { uppercase: false } })),
];

export interface RenderedEmail {
  html: string;
  text: string;
}

export async function renderEmail(
  doc: EmailDocument,
  options: { preheader?: string | null } = {},
): Promise<RenderedEmail> {
  const html = await render(createElement(EmailTemplate, { doc, preheader: options.preheader }));
  return { html, text: toPlainText(html, { selectors: TEXT_SELECTORS }) };
}

/** The HTML of some blocks without the email frame, for saved block previews. */
export function renderBlocks(nodes: readonly BlockNode[]): Promise<string> {
  return render(createElement(Blocks, { nodes }));
}
