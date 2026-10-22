// Color contrast (WCAG 2.x). The gallery templates (U15) put text on the brand colors,
// and a brand color can be light or dark. The brand tokens `brand.color_on_primary`
// and `brand.color_on_accent` (brand.ts) get a text color from `readableTextColor`, so a
// button label keeps at least 4.5:1 against its background for any brand color.

/** The light text color: white. */
export const LIGHT_TEXT = "#ffffff";
/** The dark text color of the email frame (layout.ts). */
export const DARK_TEXT = "#1a1917";
/** The darkest text color, for a background where neither of the others reach 4.5:1. */
const BLACK = "#000000";

/** The minimum contrast for body text (WCAG AA). */
export const MIN_TEXT_CONTRAST = 4.5;

function channels(hex: string): [number, number, number] | null {
  let text = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(text)) text = `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  if (!/^#[0-9a-f]{6}$/.test(text)) return null;
  return [1, 3, 5].map((start) => Number.parseInt(text.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** The relative luminance of a hex color (0 to 1), or null when it is not a hex color. */
export function relativeLuminance(hex: string): number | null {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two hex colors (1 to 21). An invalid color gives 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return 1;
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The text color for a background: white when it reaches 4.5:1, else the dark text
 * color when it reaches 4.5:1, else black. When white is below 4.5:1, black is always
 * above it, so the result reaches 4.5:1 for every background color.
 */
export function readableTextColor(background: string): string {
  if (contrastRatio(background, LIGHT_TEXT) >= MIN_TEXT_CONTRAST) return LIGHT_TEXT;
  if (contrastRatio(background, DARK_TEXT) >= MIN_TEXT_CONTRAST) return DARK_TEXT;
  return BLACK;
}
