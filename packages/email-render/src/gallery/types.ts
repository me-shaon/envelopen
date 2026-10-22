import type { EmailDocument } from "../blocks/types";

/** The categories of the gallery filter, in the order the gallery shows them. */
export const GALLERY_CATEGORIES = [
  "Newsletters",
  "Announcements",
  "Onboarding",
  "Events",
  "Promotions",
  "Feedback",
] as const;
export type GalleryCategory = (typeof GALLERY_CATEGORIES)[number];

/** A starter template of the gallery (U15). */
export interface GalleryTemplate {
  /** A stable id, used in the URL of a new template: /templates/new?start=<id>. */
  id: string;
  name: string;
  /** One short sentence for the gallery card. */
  description: string;
  category: GalleryCategory;
  subject: string;
  preheader: string;
  /** A new document. Each call returns new objects, so an edit never changes the gallery. */
  document: () => EmailDocument;
}

/** Every gallery document uses the brand font of the brand kit. */
export function brandDocument(content: EmailDocument["content"]): EmailDocument {
  return { type: "doc", attrs: { font: "brand" }, content };
}
