import { describe, expect, it } from "vitest";
import { markdownToFragment, markdownToHtml } from "./markdown";
import { renderMergeTags } from "./merge-tags";
import { sanitizeHtml } from "./sanitize";

describe("Markdown templates (R69)", () => {
  it("renders Markdown and keeps merge tags in text and in link URLs", () => {
    const html = markdownToFragment(
      'Hi {{ first_name | default: "there" }}, see **[the lesson](https://x.io/a?b=1)**.\n\n[Unsubscribe]({{ unsubscribe_url }})',
    );
    expect(html).toBe(
      '<p>Hi {{ first_name | default: &quot;there&quot; }}, see <strong><a href="https://x.io/a?b=1">the lesson</a></strong>.</p>\n' +
        '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>\n',
    );
    expect(renderMergeTags(html, { unsubscribe_url: "https://t.io/u/T" }, "html")).toContain(
      'Hi there, see <strong><a href="https://x.io/a?b=1">',
    );
  });

  it("wraps the body in the email frame with the preheader escaped", () => {
    const html = markdownToHtml("Body", { preheader: "<b>Soon</b>" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("&lt;b&gt;Soon&lt;/b&gt;");
    expect(html).toContain("<p>Body</p>");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });

  it("passes raw HTML through to the sanitizer, which removes the script", async () => {
    const html = await sanitizeHtml(
      markdownToHtml('Hello <script>alert(1)</script><img src="x" onerror="alert(1)">'),
    );
    expect(html).not.toContain("script");
    expect(html).not.toContain("onerror");
  });
});
