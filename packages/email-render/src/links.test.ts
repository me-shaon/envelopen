import { describe, expect, it } from "vitest";
import { extractLinks, rewriteLinks } from "./links";

const HTML = [
  '<a href="https://example.com/a?x=1&amp;y=2">A</a>',
  '<a class="b" href="mailto:hi@example.com">Mail</a>',
  '<a href="http://example.com/b">B</a>',
  '<a href="{{ unsubscribe_url }}">Unsubscribe</a>',
  '<a href="https://example.com/c?e={{ email }}">C</a>',
  '<a href="#top">Top</a>',
  '<a href="https://example.com/a?x=1&amp;y=2">A again</a>',
].join("");

describe("link references (KTD26)", () => {
  it("indexes trackable links in document order, decoded", () => {
    expect(extractLinks(HTML)).toEqual([
      "https://example.com/a?x=1&y=2",
      "http://example.com/b",
      "https://example.com/a?x=1&y=2",
    ]);
  });

  it("rewrites only trackable links and keeps mailto and the placeholders", () => {
    const out = rewriteLinks(HTML, (index) => `https://t.example/t/c/TOKEN/${index}`);
    expect(out).toContain('href="https://t.example/t/c/TOKEN/0"');
    expect(out).toContain('href="https://t.example/t/c/TOKEN/1"');
    expect(out).toContain('href="https://t.example/t/c/TOKEN/2"');
    expect(out).toContain('href="mailto:hi@example.com"');
    expect(out).toContain('href="{{ unsubscribe_url }}"');
    expect(out).toContain('href="https://example.com/c?e={{ email }}"');
    expect(out).toContain('href="#top"');
    expect(out).not.toContain("https://example.com/a");
  });
});
