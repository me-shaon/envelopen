import { a, brandFooter, brandHeader, button, firstName, h, p, panel, t } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// An invitation: the event, a panel with when and where, and one button to reply.

export const eventInvite: GalleryTemplate = {
  id: "event-invite",
  name: "Event invite",
  description: "An invitation with the date, time, and place in a clear panel.",
  category: "Events",
  subject: '{{ first_name | default: "You" }}, join us for an evening of short talks',
  preheader: "Thursday, 14 November, 6:30 pm. Seats are limited.",
  document: () =>
    brandDocument([
      brandHeader("center"),
      h(1, "An evening of short talks"),
      p(
        "Hi ",
        firstName(),
        ", we invite you to four short talks by members of our community, with food and time to meet people after.",
      ),
      panel("accent", [
        p(t("Date", "bold"), { type: "hardBreak" }, "Thursday, 14 November"),
        p(t("Time", "bold"), { type: "hardBreak" }, "6:30 pm to 9 pm"),
        p(t("Place", "bold"), { type: "hardBreak" }, "The Harbor Room, 12 Quay Street"),
      ]),
      p(
        "Each talk is ten minutes. Topics include small gardens, repair cafes, and a year without a car.",
      ),
      button("Save my seat", "https://example.com/events/talks", { align: "center" }),
      p(
        "You cannot come? ",
        a("Watch the recording", "https://example.com/events/talks/video"),
        " the week after.",
      ),
      brandFooter(),
    ]),
};
