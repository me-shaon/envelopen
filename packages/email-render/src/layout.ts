// The email frame that block and Markdown templates share: a 600 px column on a warm
// off-white page, and dark-mode colors for clients that support
// `prefers-color-scheme` (R27). Plain strings, so the Worker and the browser share it.

export const EMAIL_WIDTH = 600;

export const EMAIL_COLORS = {
  page: "#f6f5f2",
  card: "#ffffff",
  text: "#1a1917",
  muted: "#6b675f",
  border: "#edebe6",
  link: "#4a3c77",
} as const;

export const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/** The media query that the preview's dark mode turns on for every client. */
export const DARK_MEDIA = "@media (prefers-color-scheme: dark)";

/**
 * Head CSS. The classes are on the page, the card, text, links, and the default
 * button, so dark mode changes the colors without touching the inline styles that
 * light-mode clients use. A button with its own colors keeps them.
 */
export const EMAIL_CSS = [
  "body{margin:0;padding:0}",
  "a{color:#4a3c77}",
  "img{border:0;max-width:100%;height:auto}",
  "@media (max-width:620px){.env-card{width:100% !important;border-radius:0 !important}.env-pad{padding:24px 20px !important}.env-col{display:block !important;width:100% !important}}",
  `${DARK_MEDIA}{.env-page{background:#141312 !important}.env-card{background:#1a1917 !important;border-color:#2a2826 !important}.env-text,.env-text p,.env-text h1,.env-text h2,.env-text h3,.env-text li{color:#edebe6 !important}.env-muted{color:#a39e94 !important}.env-link,.env-muted a,.env-md a{color:#d3c9f4 !important}.env-hr,.env-footer{border-color:#2a2826 !important}.env-button-default{background:#edebe6 !important;color:#141312 !important}}`,
].join("");

/**
 * Turns on the dark-mode rules regardless of the viewer's setting, for the dark
 * preview. Preview only: the stored HTML keeps the media query.
 */
export function forceDarkMode(html: string): string {
  return html.replaceAll(DARK_MEDIA, "@media all");
}
