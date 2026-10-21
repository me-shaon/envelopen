import { describe, expect, it } from "vitest";
import {
  choiceIds,
  choiceText,
  compile,
  fill,
  mergeTagNames,
  missingMergeTags,
  recordValues,
  renderMergeTags,
} from "./merge-tags";

describe("merge tags (R29)", () => {
  it("renders the fallback when the field is empty", () => {
    const html = '<p>Hi {{ first_name | default: "there" }}!</p>';
    expect(renderMergeTags(html, { first_name: "" }, "html")).toBe("<p>Hi there!</p>");
    expect(renderMergeTags(html, { first_name: null }, "html")).toBe("<p>Hi there!</p>");
    expect(renderMergeTags(html, {}, "html")).toBe("<p>Hi there!</p>");
    expect(renderMergeTags(html, { first_name: "Ana" }, "html")).toBe("<p>Hi Ana!</p>");
  });

  it("accepts the escaped quotes that React writes, and single quotes", () => {
    expect(
      renderMergeTags("{{ first_name | default: &quot;you &amp; me&quot; }}", {}, "html"),
    ).toBe("you &amp; me");
    expect(renderMergeTags("{{first_name|default:'friend'}}", {}, "html")).toBe("friend");
    expect(renderMergeTags("{{ first_name | default: &#x27;pal&#x27; }}", {}, "html")).toBe("pal");
  });

  it("escapes a value with HTML characters", () => {
    const out = renderMergeTags(
      '<p title="{{ first_name }}">{{ first_name }}</p>',
      { first_name: `<img src=x onerror="alert(1)">'&` },
      "html",
    );
    expect(out).toBe(
      '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;</p>',
    );
    expect(out).not.toContain("<img");
  });

  it("escapes a fallback in HTML and keeps text as is in plain text", () => {
    expect(renderMergeTags('{{ course | default: "R&D <101>" }}', {}, "html")).toBe(
      "R&amp;D &lt;101&gt;",
    );
    expect(renderMergeTags("Hi {{ first_name }} <3", { first_name: "A&B" }, "text")).toBe(
      "Hi A&B <3",
    );
  });

  it("renders an unknown tag without a fallback as empty, and leaves other braces alone", () => {
    expect(renderMergeTags("a{{ nope }}b {{ not a tag }} {x}", {}, "html")).toBe(
      "ab {{ not a tag }} {x}",
    );
  });

  it("compiles once and fills many recipients", () => {
    const template = compile('{{ email }}: {{ first_name | default: "there" }}', "html");
    expect(template.tags).toEqual([
      { name: "email", fallback: null },
      { name: "first_name", fallback: "there" },
    ]);
    expect(fill(template, recordValues({ email: "a@x.io" }))).toBe("a@x.io: there");
    expect(fill(template, recordValues({ email: "b@x.io", first_name: "Bo" }))).toBe("b@x.io: Bo");
  });

  it("does not read inherited properties as fields", () => {
    expect(renderMergeTags("{{ constructor }}{{ toString }}", {}, "html")).toBe("");
  });

  it("lists tag names and the tags that would render empty", () => {
    const html =
      '{{ first_name | default: "x" }} {{ course }} {{ @open }} {{ course }} {{ email }}';
    expect(mergeTagNames(html)).toEqual(["first_name", "course", "email"]);
    expect(missingMergeTags(html, { email: "a@x.io" })).toEqual(["course"]);
  });

  it("prints the labels of a choice value in option order, joined with commas", () => {
    const options = [
      { id: 7, label: "Design" },
      { id: 3, label: "Data & AI" },
      { id: 9, label: "Writing" },
    ];
    expect(choiceIds("[9,7]")).toEqual([9, 7]);
    expect(choiceIds("3")).toEqual([3]);
    expect(choiceIds("not json")).toEqual([]);
    expect(choiceText("[9,7]", options)).toBe("Design, Writing");
    expect(choiceText("3", options)).toBe("Data & AI");
    // A deleted option is left out. No option left gives no value, so the fallback shows.
    expect(choiceText("[4]", options)).toBeNull();
    const interests = choiceText("[3,9]", options);
    expect(renderMergeTags('{{ interests | default: "none" }}', { interests }, "html")).toBe(
      "Data &amp; AI, Writing",
    );
    expect(renderMergeTags('{{ interests | default: "none" }}', {}, "text")).toBe("none");
  });
});
