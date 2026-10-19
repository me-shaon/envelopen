import {
  EDITOR_VERSION,
  htmlToText,
  isBlockList,
  isEmailDocument,
  markdownToHtml,
  sanitizeHtml,
} from "@envelopen/email-render";
import { OperationError } from "../errors";

// What a template stores, from what a client sends (KTD26, KTD27, R69):
// - `blocks`: the editor JSON and the HTML that the browser rendered with React Email.
// - `html`: HTML from the API.
// - `markdown`: Markdown from the API, rendered here into the shared email frame.
// Every format's HTML passes the sanitizer before it is stored, whatever the surface:
// the editor's raw HTML block is user input too. An HTML template also stores the
// sanitized HTML as its source, so nothing unsafe rests in the database.

export const TEMPLATE_FORMATS = ["blocks", "html", "markdown"] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

export const MAX_SOURCE_LENGTH = 500_000;

export interface ContentInput {
  format: TemplateFormat;
  source: string;
  /** Required for blocks: the browser's rendering. Ignored for the other formats. */
  html?: string | undefined;
  /** The plain-text part. Envelopen derives it when it is missing. */
  text?: string | null | undefined;
  preheader?: string | null | undefined;
}

export interface StoredContent {
  format: TemplateFormat;
  source: string;
  html: string;
  text: string;
  editor_version: number | null;
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

export async function prepareContent(input: ContentInput): Promise<StoredContent> {
  switch (input.format) {
    case "blocks": {
      const doc = parseJson(input.source);
      if (!isEmailDocument(doc)) {
        throw new OperationError("invalid_input", "The source is not a valid block document.");
      }
      if (input.html === undefined || input.html.trim() === "") {
        throw new OperationError(
          "invalid_input",
          "A block template needs the HTML that the editor rendered from it.",
        );
      }
      const html = await sanitizeHtml(input.html);
      return {
        format: "blocks",
        source: JSON.stringify(doc),
        html,
        text: input.text ?? (await htmlToText(html)),
        editor_version: EDITOR_VERSION,
      };
    }
    case "html": {
      const html = await sanitizeHtml(input.source);
      return {
        format: "html",
        source: html,
        html,
        text: input.text ?? (await htmlToText(html)),
        editor_version: null,
      };
    }
    case "markdown": {
      const html = await sanitizeHtml(markdownToHtml(input.source, { preheader: input.preheader }));
      return {
        format: "markdown",
        source: input.source,
        html,
        text: input.text ?? input.source,
        editor_version: null,
      };
    }
  }
}

/** Checks the JSON of a saved block: a list of editor block nodes. */
export function parseBlockContent(content: string): string {
  const nodes = parseJson(content);
  if (!isBlockList(nodes)) {
    throw new OperationError("invalid_input", "The content is not a valid list of blocks.");
  }
  return JSON.stringify(nodes);
}
