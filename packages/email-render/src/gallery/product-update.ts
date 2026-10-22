import { brandFooter, brandHeader, button, columns, divider, h, p, t } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// A release note: two new features side by side, then a short list of fixes.

export const productUpdate: GalleryTemplate = {
  id: "product-update",
  name: "Product update",
  description: "New features side by side, then a short list of fixes.",
  category: "Announcements",
  subject: "What is new in version 2.4",
  preheader: "Shared folders, faster search, and nine fixes.",
  document: () =>
    brandDocument([
      brandHeader("left", { logoWidth: 120 }),
      h(1, "What is new in version 2.4"),
      p(
        "This release is about working together. It is live for everyone today. You do not need to update anything.",
      ),
      columns(
        [
          h(3, "Shared folders"),
          p("Invite a teammate to a folder. They see the same files and every change you make."),
        ],
        [
          h(3, "Faster search"),
          p("Search now looks inside your notes too, and shows results while you type."),
        ],
      ),
      divider(),
      h(2, "Fixes and small changes"),
      p(t("Exports: ", "bold"), "large exports no longer stop at 10,000 rows."),
      p(t("Dates: ", "bold"), "the calendar now starts the week on your chosen day."),
      p(t("Mobile: ", "bold"), "the menu no longer covers the save button on small screens."),
      button("Read the full changelog", "https://example.com/changelog", { tone: "accent" }),
      brandFooter(),
    ]),
};
