import { decodeEntities } from "./merge-tags";

// The plain-text part for API HTML templates, when the client sends none. The editor
// makes its own text part with React Email in the browser. Workers runtime only
// (HTMLRewriter). It keeps paragraphs, line breaks, list items, and link URLs.

// biome-ignore format: one tag per line would make the list hard to scan.
const BLOCK = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "ul", "ol", "blockquote",
  "pre", "hr", "section", "article", "header", "footer", "center",
]);
const SKIP = new Set(["head", "style", "title", "script"]);

export async function htmlToText(html: string): Promise<string> {
  const out: string[] = [];
  let skip = 0;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (SKIP.has(tag)) {
          skip++;
          element.onEndTag(() => {
            skip--;
          });
          return;
        }
        if (tag === "br") out.push("\n");
        else if (tag === "li") out.push("\n- ");
        else if (BLOCK.has(tag)) {
          out.push("\n\n");
          element.onEndTag(() => {
            out.push("\n\n");
          });
        } else if (tag === "a") {
          const href = decodeEntities(element.getAttribute("href") ?? "").trim();
          if (/^(https?:|mailto:|\{\{)/i.test(href)) {
            element.onEndTag(() => {
              out.push(` (${href.replace(/^mailto:/i, "")})`);
            });
          }
        }
      },
    })
    // Document text handlers see each text chunk once, in stream order.
    .onDocument({
      text(chunk) {
        if (skip === 0) out.push(chunk.text);
      },
    });
  await rewriter.transform(new Response(html)).text();
  return decodeEntities(out.join(""))
    .replace(/[ \t\r\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
