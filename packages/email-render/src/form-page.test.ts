import { describe, expect, it } from "vitest";
import {
  embedSnippet,
  FORM_COPY,
  type FormPageForm,
  recommendedFormHeight,
  renderFormPage,
  usesTurnstile,
} from "./form-page";

// The signup form page (U8): escaping, the page states, and the embed height.

const ATTACK = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const layout = { nonce: "n0nce", sourceUrl: "https://example.com/src", version: "0.3.0" };

const form: FormPageForm = {
  name: ATTACK,
  consentText: `${ATTACK}\nLine two`,
  successMessage: ATTACK,
  fields: [
    { key: "city", label: ATTACK, type: "text", options: [] },
    {
      key: "topics",
      label: "Topics",
      type: "multi",
      options: [
        { id: 1, label: ATTACK },
        { id: 2, label: "Data" },
      ],
    },
  ],
};

describe("renderFormPage", () => {
  it("renders every text of the owner and the subscriber as plain text", () => {
    const views = [
      {
        kind: "form" as const,
        form,
        action: "/f/abc",
        siteKey: ATTACK,
        values: { email: ATTACK, fields: { city: ATTACK, topics: ["2"] } },
        errors: [{ target: "email", message: ATTACK }],
      },
      { kind: "inbox" as const, form, backHref: "/f/abc" },
      { kind: "confirm" as const, form, action: "/f/confirm/t" },
      { kind: "confirmed" as const, form },
      {
        kind: "expired" as const,
        form,
        action: "/f/confirm/t/resend",
        siteKey: "k",
        canResend: true,
      },
      { kind: "unavailable" as const, detail: ATTACK },
    ];
    for (const view of views) {
      const html = renderFormPage(view, layout);
      expect(html, view.kind).not.toContain("<script>alert");
      expect(html, view.kind).not.toContain("<img src=x");
      expect(html, view.kind).not.toContain('"><script');
    }
    const page = renderFormPage(views[0] as (typeof views)[0], layout);
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The checked option stays checked, and only the Turnstile script loads.
    expect(page).toContain('value="2" checked');
    expect(page.match(/<script /g)).toHaveLength(1);
  });

  it("ties each label to its input and puts the error summary first", () => {
    const html = renderFormPage(
      {
        kind: "form",
        form,
        action: "/f/abc",
        siteKey: "key",
        errors: [{ target: "field-city", message: "Use fewer characters." }],
      },
      layout,
    );
    expect(html).toContain('<label for="email">');
    expect(html).toContain('<label for="field-city">');
    expect(html).toContain('id="field-city"');
    expect(html).toContain("<fieldset><legend>Topics</legend>");
    expect(html.indexOf('class="errors"')).toBeLessThan(html.indexOf("<form"));
    expect(html).toContain('<a href="#field-city">Use fewer characters.</a>');
    expect(html).toContain('id="consent"');
  });

  it("shows a placeholder and no script in the preview", () => {
    const view = { kind: "form" as const, form, action: "#", siteKey: null };
    expect(usesTurnstile(view)).toBe(false);
    const html = renderFormPage(view, layout);
    expect(html).not.toContain("<script");
    expect(html).toContain(FORM_COPY.previewWidget);
  });

  it("recommends more height for more fields and escapes the snippet", () => {
    const base = recommendedFormHeight([]);
    expect(recommendedFormHeight(form.fields)).toBeGreaterThan(base);
    expect(base % 10).toBe(0);
    const snippet = embedSnippet("https://mail.example.com/f/abc", ATTACK, base);
    expect(snippet).toContain('src="https://mail.example.com/f/abc?embed=1"');
    expect(snippet).toContain(`height="${base}"`);
    expect(snippet).not.toContain("<script");
  });
});

describe("required fields (U9)", () => {
  it("marks a required field, escapes its label, and shows its error", () => {
    const html = renderFormPage(
      {
        kind: "form",
        form: {
          ...form,
          fields: [
            { key: "frequency", label: ATTACK, type: "choice", options: [], required: true },
            { key: "city", label: "City", type: "text", options: [], required: true },
          ],
        },
        action: "/f/abc",
        siteKey: null,
        errors: [{ target: "field-city", message: FORM_COPY.requiredValue("City") }],
      },
      layout,
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain(`<legend>&quot;&gt;&lt;script&gt;`);
    expect(html).toContain(`City <span class="req">${FORM_COPY.requiredMark}</span>`);
    expect(html).toContain('aria-required="true" aria-invalid="true"');
    expect(html).toContain("Enter a value for City.");
  });
});
