import { describe, expect, it } from "vitest";
import { isEmailDocument } from "../blocks/types";
import { applyBrand, type BrandSnapshot, DEFAULT_BRAND } from "../brand";
import { contrastRatio, MIN_TEXT_CONTRAST, readableTextColor } from "../contrast";
import { decodeEntities } from "../merge-tags";
import { renderEmail } from "../render";
import { sanitizeHtml } from "../sanitize";
import { GALLERY_CATEGORIES, GALLERY_TEMPLATES, galleryTemplate } from ".";

// The template gallery (U15). Every template is a valid block document, passes the
// sanitizer without losing anything, stays under 100 KB, renders with and without a
// logo, and keeps text on brand colors at 4.5:1 or more for a dark and a light brand.
// This file runs in workerd, where the sanitizer (HTMLRewriter) runs.

const LOGO = "https://app.example.com/b/1/logo.png";

const DARK_BRAND: BrandSnapshot = {
  ...DEFAULT_BRAND,
  name: "Harbor Studio",
  logoUrl: LOGO,
  colorPrimary: "#1f4e5f",
  colorAccent: "#e3f0ec",
  font: "georgia",
  footer: "You get this email because you joined Harbor Studio.",
  address: "12 Quay Street, Bristol BS1 4DJ",
  social: { website: "https://example.com", x: "https://x.com/harbor" },
};

/** A light primary color: white text on it is below 4.5:1, so dark text must apply. */
const LIGHT_BRAND: BrandSnapshot = {
  ...DARK_BRAND,
  name: "Sunny Days",
  colorPrimary: "#f5c542",
  colorAccent: "#2b2d6e",
  font: "system",
};

const BRANDS = { dark: DARK_BRAND, light: LIGHT_BRAND };

/**
 * Counts each element name and each attribute name, to compare before and after. React
 * Email's own `data-` markers are left out: the sanitizer drops them from every email.
 */
function shape(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const tag of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g)) {
    const name = (tag[1] as string).toLowerCase();
    add(`<${name}>`);
    for (const attr of (tag[2] as string).matchAll(/\s([a-zA-Z-:]+)=/g)) {
      const attribute = (attr[1] as string).toLowerCase();
      if (!attribute.startsWith("data-")) add(`${name}[${attribute}]`);
    }
  }
  return counts;
}

/** The background and text color of every element that sets both in its style. */
function colorPairs(html: string): { background: string; color: string; where: string }[] {
  const pairs: { background: string; color: string; where: string }[] = [];
  for (const match of html.matchAll(/style="([^"]*)"/g)) {
    const style = decodeEntities(match[1] as string);
    const background = /(?:^|;)\s*background(?:-color)?:\s*(#[0-9a-f]{3,6})/i.exec(style)?.[1];
    const color = /(?:^|;)\s*color:\s*(#[0-9a-f]{3,6})/i.exec(style)?.[1];
    if (background && color) pairs.push({ background, color, where: style.slice(0, 80) });
  }
  return pairs;
}

describe("contrast helper", () => {
  it("picks white on a dark color and dark text on a light color", () => {
    expect(readableTextColor("#1f4e5f")).toBe("#ffffff");
    expect(readableTextColor("#f5c542")).toBe("#1a1917");
    expect(readableTextColor("#ede9f8")).toBe("#1a1917");
  });

  it("reaches 4.5:1 for every gray from black to white", () => {
    for (let value = 0; value <= 255; value += 1) {
      const hex = `#${value.toString(16).padStart(2, "0").repeat(3)}`;
      expect(contrastRatio(hex, readableTextColor(hex)), hex).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    }
  });
});

describe("gallery templates", () => {
  it("has about ten templates with unique ids, known categories, and real copy", () => {
    expect(GALLERY_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    const ids = GALLERY_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of GALLERY_TEMPLATES) {
      expect(GALLERY_CATEGORIES).toContain(template.category);
      expect(template.name && template.description && template.preheader).toBeTruthy();
      expect(template.subject).toBeTruthy();
      expect(galleryTemplate(template.id)).toBe(template);
      const copy = JSON.stringify(template);
      expect(copy).not.toMatch(/lorem|ipsum|—/i);
    }
    expect(galleryTemplate("nope")).toBeNull();
  });

  for (const template of GALLERY_TEMPLATES) {
    describe(template.name, () => {
      it("is a block document with the brand blocks, and each call gives a new copy", () => {
        const doc = template.document();
        expect(isEmailDocument(doc)).toBe(true);
        expect(doc.attrs?.font).toBe("brand");
        expect(doc.content[0]?.type).toBe("brandHeader");
        expect(doc.content.at(-1)?.type).toBe("brandFooter");
        // Only builder blocks: no raw HTML, so every part edits in the visual builder.
        expect(JSON.stringify(doc)).not.toContain('"type":"html"');
        expect(template.document()).not.toBe(doc);
        expect(template.document()).toEqual(doc);
      });

      it("sanitizes with no removals and renders under 100 KB", async () => {
        const { html, text } = await renderEmail(template.document(), {
          preheader: template.preheader,
        });
        expect(new TextEncoder().encode(html).length).toBeLessThan(100_000);
        expect(text).toContain("Unsubscribe");
        const clean = await sanitizeHtml(html);
        // The sanitizer drops every comment by design (React's markers and the Outlook
        // conditional comments of the button). No element or attribute goes.
        expect(clean).not.toContain("<!--");
        expect(shape(clean)).toEqual(shape(html.replace(/<!--[\s\S]*?-->/g, "")));
        for (const brand of Object.values(BRANDS)) {
          const filled = applyBrand(clean, brand, "html");
          expect(new TextEncoder().encode(filled).length).toBeLessThan(100_000);
        }
      });

      it("renders the logo when the brand has one, and no image without one", async () => {
        const { html } = await renderEmail(template.document());
        const withLogo = applyBrand(html, DARK_BRAND, "html");
        expect(withLogo).toContain(`src="${LOGO}"`);
        expect(withLogo).toContain('alt="Harbor Studio"');
        // The only image of a gallery template is the brand logo: no remote stock images.
        expect(withLogo.match(/<img\b/g)?.length).toBe(1);

        const noLogo = applyBrand(html, { ...DARK_BRAND, logoUrl: null }, "html");
        expect(noLogo).not.toMatch(/<img\b/);
        expect(noLogo).not.toMatch(/\{\{\s*brand\./);
        const empty = applyBrand(html, DEFAULT_BRAND, "html");
        expect(empty).not.toMatch(/<img\b/);
        expect(empty).not.toMatch(/\{\{\s*brand\./);
      });

      for (const [name, brand] of Object.entries(BRANDS)) {
        it(`keeps text on brand colors at 4.5:1 or more for the ${name} brand`, async () => {
          const { html } = await renderEmail(template.document());
          const filled = applyBrand(html, brand, "html");
          const pairs = colorPairs(filled);
          for (const pair of pairs) {
            expect(contrastRatio(pair.background, pair.color), pair.where).toBeGreaterThanOrEqual(
              MIN_TEXT_CONTRAST,
            );
          }
        });
      }
    });
  }

  it("uses dark text on the light brand's primary color and white on the dark one", async () => {
    const { html } = await renderEmail(
      galleryTemplate("newsletter")?.document() ?? { type: "doc", content: [] },
    );
    expect(applyBrand(html, LIGHT_BRAND, "html")).toContain("background:#f5c542;color:#1a1917");
    expect(applyBrand(html, DARK_BRAND, "html")).toContain("background:#1f4e5f;color:#ffffff");
  });

  it("writes the brand name and social links in the primary color only when it is readable", async () => {
    const doc = galleryTemplate("welcome")?.document() ?? { type: "doc" as const, content: [] };
    const { html } = await renderEmail(doc);
    expect(html).toContain("color:{{ brand.color_primary_text }}");
    // A light primary color (#f5c542 is 1.6:1 on white) gives dark text.
    const light = applyBrand(html, LIGHT_BRAND, "html");
    expect(light).toContain("font-weight:600;color:#1a1917;font-family:");
    expect(light).toMatch(/href="https:\/\/x\.com\/harbor" style="color:#1a1917/);
    expect(light).not.toMatch(/color:#f5c542[;"]/);
    // A dark primary color stays.
    const dark = applyBrand(html, DARK_BRAND, "html");
    expect(dark).toContain("font-weight:600;color:#1f4e5f;font-family:");
  });

  it("renders panels as one-cell tables with the readable text color, also in dark mode", async () => {
    const doc = galleryTemplate("sale")?.document() ?? { type: "doc" as const, content: [] };
    const { html } = await renderEmail(doc);
    expect(html).toContain('class="env-panel"');
    expect(html).toContain('bgcolor="{{ brand.color_primary }}"');
    expect(html).toContain("color:{{ brand.color_on_primary }}");
    expect(html).toContain(".env-text .env-panel p");
    const light = applyBrand(html, LIGHT_BRAND, "html");
    expect(light).toContain('bgcolor="#f5c542"');
    expect(light).toMatch(/background:#f5c542;color:#1a1917/);
  });
});
