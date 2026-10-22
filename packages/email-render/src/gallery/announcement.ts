import { brandFooter, brandHeader, button, firstName, h, p, panel } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// One big piece of news: a primary-color panel with the headline, then one button.

export const announcement: GalleryTemplate = {
  id: "announcement",
  name: "Announcement",
  description: "One piece of news in a bold brand-color panel.",
  category: "Announcements",
  subject: "Something new is here",
  preheader: "Today we open our new space for members. You are among the first to know.",
  document: () =>
    brandDocument([
      brandHeader("center"),
      panel(
        "primary",
        [
          h(1, "Our new studio is open"),
          p("A bigger room, longer hours, and space for twelve more members."),
        ],
        { align: "center", padding: 40 },
      ),
      p(
        "Hi ",
        firstName(),
        ", after six months of work, the new studio on Harbor Street is ready. It opens on Monday at 9 am.",
      ),
      p(
        "Members get free entry in the first week. Bring a friend, have a coffee with us, and see the new room.",
      ),
      button("Plan your visit", "https://example.com/studio", { align: "center" }),
      brandFooter(),
    ]),
};
