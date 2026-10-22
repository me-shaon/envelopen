// The template gallery (U15, R20): starter templates as block documents that use the
// brand tokens (U13). Each one opens in the builder unchanged. Data only: no React, so
// the browser, the Worker, and the tests share it.
import { announcement } from "./announcement";
import { digest } from "./digest";
import { eventInvite } from "./event-invite";
import { newsletter } from "./newsletter";
import { plainLetter } from "./plain-letter";
import { productUpdate } from "./product-update";
import { reEngagement } from "./re-engagement";
import { sale } from "./sale";
import { survey } from "./survey";
import type { GalleryTemplate } from "./types";
import { welcome } from "./welcome";

export { GALLERY_CATEGORIES, type GalleryCategory, type GalleryTemplate } from "./types";

/** The gallery templates, in the order the gallery shows them. */
export const GALLERY_TEMPLATES: readonly GalleryTemplate[] = [
  newsletter,
  announcement,
  welcome,
  productUpdate,
  eventInvite,
  digest,
  plainLetter,
  sale,
  survey,
  reEngagement,
];

/** The gallery template with the id, or null. */
export function galleryTemplate(id: unknown): GalleryTemplate | null {
  return GALLERY_TEMPLATES.find((template) => template.id === id) ?? null;
}
