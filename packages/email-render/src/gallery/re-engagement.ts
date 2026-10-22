import { a, brandFooter, brandHeader, button, columns, firstName, h, p, panel } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// A check-in for a quiet subscriber: what they missed, and an honest way to leave.

export const reEngagement: GalleryTemplate = {
  id: "re-engagement",
  name: "Re-engagement",
  description: "A friendly check-in for quiet subscribers, with an easy way out.",
  category: "Feedback",
  subject: '{{ first_name | default: "Hi" }}, do you still want our emails?',
  preheader: "Here is what you missed. Stay, or leave with one click.",
  document: () =>
    brandDocument([
      brandHeader("center"),
      h(1, "We miss you, ", firstName("friend")),
      p(
        "You have not opened our emails for a while. That is fine. We want to send email only to people who want it.",
      ),
      panel("accent", [
        h(3, "What you missed"),
        p("A new guide for beginners, a calendar view, and two new tools."),
      ]),
      columns(
        [h(3, "Stay"), p("Click the button. We keep sending you the monthly letter.")],
        [h(3, "Send less"), p("Choose fewer emails in your email preferences below.")],
      ),
      button("Yes, keep me on the list", "https://example.com/stay", { align: "center" }),
      p(
        "Not interested anymore? ",
        a("Unsubscribe here", "{{ unsubscribe_url }}"),
        ". No hard feelings.",
      ),
      brandFooter(),
    ]),
};
