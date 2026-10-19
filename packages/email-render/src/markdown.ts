import { Marked } from "marked";
import { EMAIL_COLORS, EMAIL_CSS, EMAIL_FONT, EMAIL_WIDTH } from "./layout";
import { escapeHtml } from "./merge-tags";

// Markdown templates from the API (R69). marked turns the Markdown into HTML inside the
// shared email frame. The result is not trusted: Markdown can hold raw HTML, so the
// template service sanitizes it like any other API HTML (KTD27).
//
// Merge tags need care: marked percent-encodes URLs, which would turn
// `[Unsubscribe]({{ unsubscribe_url }})` into `%7B%7B...`. Each tag is swapped for a
// plain placeholder before parsing and put back afterward.

const TAG = /\{\{[^{}]*\}\}/g;

// One instance with fixed options, so a global `marked.use()` elsewhere cannot change it.
const parser = new Marked({ gfm: true, breaks: false, async: false });

function protectTags(markdown: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const text = markdown.replace(TAG, (tag) => {
    tags.push(tag);
    return `mergetag${tags.length - 1}x`;
  });
  return { text, tags };
}

function restoreTags(html: string, tags: readonly string[]): string {
  // Escaped quotes work in both text and attributes, and merge-tags.ts accepts them.
  return html.replace(/mergetag(\d+)x/g, (whole, index: string) => {
    const tag = tags[Number(index)];
    return tag === undefined ? whole : escapeHtml(tag).replaceAll("&#39;", "'");
  });
}

/** The Markdown body as an HTML fragment, merge tags kept. */
export function markdownToFragment(markdown: string): string {
  const { text, tags } = protectTags(markdown);
  return restoreTags(parser.parse(text) as string, tags);
}

/** A full email document for a Markdown template. Sanitize the result before storing it. */
export function markdownToHtml(
  markdown: string,
  options: { preheader?: string | null } = {},
): string {
  const body = markdownToFragment(markdown);
  const preheader = options.preheader
    ? `<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">${escapeHtml(options.preheader)}</div>`
    : "";
  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<style>${EMAIL_CSS}</style></head>`,
    `<body class="env-page" style="margin:0;padding:0;background:${EMAIL_COLORS.page}">`,
    preheader,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="env-page" style="background:${EMAIL_COLORS.page}"><tr><td align="center" style="padding:32px 12px">`,
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" class="env-card" style="width:${EMAIL_WIDTH}px;max-width:100%;background:${EMAIL_COLORS.card};border:1px solid ${EMAIL_COLORS.border};border-radius:12px">`,
    `<tr><td class="env-pad env-text env-md" style="padding:36px 40px;font-family:${EMAIL_FONT};font-size:16px;line-height:1.6;color:${EMAIL_COLORS.text}">`,
    body,
    "</td></tr></table></td></tr></table></body></html>",
  ].join("");
}
