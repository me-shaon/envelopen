import { describe, expect, it } from "vitest";
import { extractLinks } from "./links";
import { markdownToHtml } from "./markdown";
import { safeUrl, sanitizeHtml, unsafeCss } from "./sanitize";

describe("sanitizeHtml (KTD27)", () => {
  it("removes script elements and event handler attributes", async () => {
    const out = await sanitizeHtml(
      '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="https://x.io/a.png" onerror="alert(1)" alt="A"><body onload="x()">',
    );
    expect(out).toBe('<p>Hi</p><img src="https://x.io/a.png" alt="A"><body>');
  });

  it("removes javascript: and other unsafe URLs, also when encoded", async () => {
    const out = await sanitizeHtml(
      [
        '<a href="javascript:alert(1)">1</a>',
        '<a href="jav&#x61;script:alert(1)">2</a>',
        '<a href="java\tscript:alert(1)">3</a>',
        '<a href=" JAVASCRIPT:alert(1)">4</a>',
        '<a href="data:text/html,<script>alert(1)</script>">5</a>',
        '<a href="vbscript:x">6</a>',
        '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
        '<a href="{{ website }}">7</a>',
      ].join(""),
    );
    expect(out).toBe("<a>1</a><a>2</a><a>3</a><a>4</a><a>5</a><a>6</a><img><a>7</a>");
  });

  it("keeps safe links, merge tags after a scheme, and the unsubscribe placeholders", async () => {
    const out = await sanitizeHtml(
      "<a href='https://x.io/?a=1&amp;b=2' target=_blank>a</a><a href=\"mailto:hi@x.io\">m</a>" +
        '<a href="{{ unsubscribe_url }}">u</a><a href="https://x.io/?e={{ email }}">e</a><a href="#top" target="_top">t</a>',
    );
    expect(out).toBe(
      '<a href="https://x.io/?a=1&amp;b=2" target="_blank">a</a><a href="mailto:hi@x.io">m</a>' +
        '<a href="{{ unsubscribe_url }}">u</a><a href="https://x.io/?e={{ email }}">e</a><a href="#top">t</a>',
    );
  });

  it("drops embedding elements with their content and unwraps unknown ones", async () => {
    const out = await sanitizeHtml(
      '<iframe src="https://x.io"></iframe><svg><a href="https://x.io">s</a></svg><math><mi>x</mi></math>' +
        '<form action="https://x.io"><input name="p"><span>kept</span></form><object data="x"></object>' +
        '<noscript><p>n</p></noscript><custom-tag data-x="1">text</custom-tag><base href="https://evil.io/">' +
        '<meta http-equiv="refresh" content="0;url=https://evil.io"><meta name="color-scheme" content="light dark">',
    );
    expect(out).toBe('<span>kept</span>text<meta name="color-scheme" content="light dark">');
  });

  it("removes comments, including conditional comments", async () => {
    expect(
      await sanitizeHtml("<p>a<!-- x --><!--[if mso]><script>x</script><![endif]-->b</p>"),
    ).toBe("<p>ab</p>");
  });

  it("drops unsafe CSS in style attributes and style elements", async () => {
    const out = await sanitizeHtml(
      "<style>.a{color:red}</style><style>.b{background:url(javascript:alert(1))}</style>" +
        '<p style="color:red">ok</p><p style="width:expression(alert(1))">x</p>' +
        '<p style="background:url(&quot;https://x.io/a.png&quot;)">u</p><p style="behavior:url(x.htc)">b</p>',
    );
    expect(out).toBe(
      '<style>.a{color:red}</style><style></style><p style="color:red">ok</p><p>x</p>' +
        '<p style="background:url(&quot;https://x.io/a.png&quot;)">u</p><p>b</p>',
    );
  });

  it("writes every attribute in double quotes, so the link pattern finds all hrefs", async () => {
    const out = await sanitizeHtml(
      "<a title='say \"hi\"' href='https://x.io/1'>1</a><a href=https://x.io/2>2</a>",
    );
    expect(out).toBe(
      '<a title="say &quot;hi&quot;" href="https://x.io/1">1</a><a href="https://x.io/2">2</a>',
    );
    expect(extractLinks(out)).toEqual(["https://x.io/1", "https://x.io/2"]);
  });

  it("keeps the email frame: doctype, head CSS for dark mode, tables, and inline styles", async () => {
    const html = markdownToHtml(
      "# Hello {{ first_name }}\n\n[Unsubscribe]({{ unsubscribe_url }})",
      {
        preheader: "Pre",
      },
    );
    const out = await sanitizeHtml(html);
    expect(out).toBe(html);
  });
});

describe("URL and CSS checks", () => {
  const LINK = new Set(["http", "https", "mailto", "tel"]);
  it("accepts allowed schemes and placeholders only", () => {
    expect(safeUrl("https://x.io", LINK)).toBe("https://x.io");
    expect(safeUrl("tel:+15550100", LINK)).toBe("tel:+15550100");
    expect(safeUrl("{{ preferences_url }}", LINK)).toBe("{{ preferences_url }}");
    expect(safeUrl("//evil.io", LINK)).toBeNull();
    expect(safeUrl("relative/path", LINK)).toBeNull();
    expect(safeUrl("\u0001javascript:x", LINK)).toBeNull();
  });

  it("catches CSS escapes and comments", () => {
    expect(unsafeCss("width: ex\\70 ression(1)")).toBe(true);
    expect(unsafeCss("width: expr/**/ession(1)")).toBe(true);
    expect(unsafeCss("x: java/**/script:")).toBe(true);
    expect(unsafeCss("@\\69mport url(https://x.io/a.css)")).toBe(true);
    expect(unsafeCss("color: #fff; background: url('https://x.io/a.png')")).toBe(false);
  });
});
