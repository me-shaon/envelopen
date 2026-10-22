import { describe, expect, it } from "vitest";
import { testKey } from "../test/keys";
import { SOCIAL_NETWORKS } from "./blocks/types";
import {
  applyBrand,
  type BrandSnapshot,
  brandUrl,
  DEFAULT_BRAND,
  normalizeHexColor,
  parseBrandSnapshot,
} from "./brand";
import { BRAND_TAGS, mergeTagNames, RESERVED_TAGS } from "./merge-tags";
import { personalize, prepareMessage } from "./personalize";
import { sanitizeHtml } from "./sanitize";
import { createTokenSigner } from "./tokens";

// Brand tokens (U13, KTD10): string substitution with checked and escaped values.

const BRAND: BrandSnapshot = {
  name: "Acme Studio",
  logoUrl: "https://app.example.com/b/1/abc.png",
  logoKey: "brand/1/abc.png",
  colorPrimary: "#112233",
  colorAccent: "#ffeedd",
  font: "georgia",
  footer: "Made with care.",
  address: "1 Main Street, Springfield",
  social: { x: "https://x.com/acme" },
};

const TEMPLATE =
  '<html><body><img src="{{ brand.logo_url }}" alt="{{ brand.name }}" width="160">' +
  '<p style="color:{{ brand.color_primary }};font-family:{{ brand.font }}">{{ brand.name }}</p>' +
  '<a href="https://example.com/a" style="background:{{ brand.color_accent }}">Read</a>' +
  '<p><a href="{{ brand.social.x }}">X</a> <a href="{{ brand.social.github }}">GitHub</a></p>' +
  "<p>{{ brand.footer }}</p><p>{{ brand.address }}</p>" +
  '<a href="{{ unsubscribe_url }}">Unsubscribe</a></body></html>';

describe("brand tokens", () => {
  it("lists every brand tag as reserved, with one social tag per network", () => {
    for (const tag of BRAND_TAGS) expect(RESERVED_TAGS).toContain(tag);
    expect(BRAND_TAGS.filter((tag) => tag.startsWith("brand.social.")).sort()).toEqual(
      SOCIAL_NETWORKS.map((network) => `brand.social.${network}`).sort(),
    );
    expect(mergeTagNames("{{ brand.name }} {{ first_name }}")).toEqual([
      "brand.name",
      "first_name",
    ]);
  });

  it("fills the tokens with literal values in inline styles", () => {
    const html = applyBrand(TEMPLATE, BRAND, "html");
    expect(html).toContain('src="https://app.example.com/b/1/abc.png"');
    expect(html).toContain(
      'style="color:#112233;font-family:Georgia, Times New Roman, Times, serif"',
    );
    expect(html).toContain('style="background:#ffeedd"');
    expect(html).toContain(">Acme Studio</p>");
    expect(html).toContain('<a href="https://x.com/acme">X</a>');
    // GitHub has no URL in the brand kit, so its link is removed.
    expect(html).not.toContain("GitHub");
    expect(html).toContain("<p>1 Main Street, Springfield</p>");
    expect(html).not.toContain("{{ brand.");
    expect(html).toContain('href="{{ unsubscribe_url }}"');
  });

  it("removes the logo image when the brand has no logo", () => {
    const html = applyBrand(TEMPLATE, { ...BRAND, logoUrl: null }, "html");
    expect(html).not.toContain("<img");
    expect(html).toContain(">Acme Studio</p>");
  });

  it("returns a template without brand tokens unchanged", () => {
    const html = '<p style="color:#123456">Hi {{ first_name }}, brand.name is text.</p>';
    expect(applyBrand(html, BRAND, "html")).toBe(html);
    expect(applyBrand("Subject {{ first_name }}", BRAND, "text")).toBe("Subject {{ first_name }}");
  });

  it("escapes hostile text values and never lets them form a merge tag", () => {
    const hostile: BrandSnapshot = {
      ...BRAND,
      name: `"><script>alert(1)</script>{{ unsubscribe_url }}`,
      footer: "Tom & Jerry's <b>",
    };
    const html = applyBrand(TEMPLATE, hostile, "html");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&#123;&#123; unsubscribe_url &#125;&#125;");
    expect(html).toContain("Tom &amp; Jerry&#39;s &lt;b&gt;");
    // The alt attribute keeps its quotes.
    expect(html).toMatch(/alt="&quot;&gt;&lt;script&gt;/);
    expect(applyBrand("News from {{ brand.name }}", hostile, "text")).toBe(
      `News from "><script>alert(1)</script>{ { unsubscribe_url } }`,
    );
  });

  it("refuses a CSS injection in a color, a javascript: link, and an unknown font", () => {
    const hostile = parseBrandSnapshot({
      ...BRAND,
      colorPrimary: "red;background:url(javascript:alert(1))",
      colorAccent: "#12345g",
      font: "Comic Sans'; behavior:url(x)",
      logoUrl: "javascript:alert(1)",
      social: { x: "javascript:alert(1)", github: "http://github.com/acme" },
    });
    expect(hostile.colorPrimary).toBe(DEFAULT_BRAND.colorPrimary);
    expect(hostile.colorAccent).toBe(DEFAULT_BRAND.colorAccent);
    expect(hostile.font).toBe("system");
    expect(hostile.logoUrl).toBeNull();
    expect(hostile.social).toEqual({});
    // The substitution checks the values again, so a raw snapshot cannot inject either.
    const html = applyBrand(
      TEMPLATE,
      { ...BRAND, colorPrimary: "red;x:expression(1)", social: { x: "javascript:alert(1)" } },
      "html",
    );
    expect(html).toContain("color:#4a3c77;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("expression");
  });

  it("checks colors and URLs", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor(" #A1b2C3 ")).toBe("#a1b2c3");
    expect(normalizeHexColor("blue")).toBeNull();
    expect(normalizeHexColor("#a1b2c3;")).toBeNull();
    expect(brandUrl("https://acme.example/a?b=1&c=2", ["https:"])).toBe(
      "https://acme.example/a?b=1&c=2",
    );
    expect(brandUrl("http://acme.example", ["https:"])).toBeNull();
    expect(brandUrl('https://acme.example/"onload=', ["https:"])).toBeNull();
    expect(brandUrl("https://user:pw@acme.example", ["https:"])).toBeNull();
    expect(brandUrl("data:text/html,x", ["https:"])).toBeNull();
  });

  it("keeps the brand URL tokens through the sanitizer, but no other tag in a URL", async () => {
    const html = await sanitizeHtml(
      '<img src="{{ brand.logo_url }}"><a href="{{ brand.social.x }}">X</a>' +
        '<a href="{{ first_name }}">bad</a><img src="{{ brand.name }}">' +
        '<p style="color:{{ brand.color_primary }}">t</p>',
    );
    expect(html).toContain('src="{{ brand.logo_url }}"');
    expect(html).toContain('href="{{ brand.social.x }}"');
    expect(html).not.toContain('href="{{ first_name }}"');
    expect(html).not.toContain('src="{{ brand.name }}"');
    expect(html).toContain('style="color:{{ brand.color_primary }}"');
  });

  it("puts the literal brand color into the sent HTML and does not track brand links", async () => {
    const signer = await createTokenSigner([{ secret: testKey(4) }]);
    const prepared = prepareMessage({
      html: TEMPLATE,
      subject: "News from {{ brand.name }}",
      text: "{{ brand.name }}\n{{ brand.address }}",
      trackingOrigin: "https://t.example.com",
      trackOpens: true,
      trackClicks: true,
      brand: BRAND,
    });
    // Only the content link is tracked. The brand links keep their URL.
    expect(prepared.links).toEqual(["https://example.com/a"]);
    const out = await personalize(
      prepared,
      { campaignId: 1, recipientId: 2, fields: { email: "a@example.org" } },
      signer,
    );
    expect(out.html).toContain('style="color:#112233;');
    expect(out.html).toContain('href="https://x.com/acme"');
    expect(out.subject).toBe("News from Acme Studio");
    expect(out.text).toBe("Acme Studio\n1 Main Street, Springfield");
  });

  it("gives the same message with any brand when the template has no brand tokens", async () => {
    const signer = await createTokenSigner([{ secret: testKey(4) }]);
    const options = {
      html: '<html><body><p>Hi {{ first_name }}</p><a href="https://e.com">e</a></body></html>',
      subject: "Hello",
      text: "Hi",
      trackingOrigin: "https://t.example.com",
      trackOpens: true,
      trackClicks: true,
    };
    const recipient = { campaignId: 1, recipientId: 2, fields: { first_name: "Ada" } };
    const plain = await personalize(prepareMessage(options), recipient, signer);
    const branded = await personalize(
      prepareMessage({ ...options, brand: BRAND }),
      recipient,
      signer,
    );
    expect(branded).toEqual(plain);
  });
});
