import { a, brandFooter, brandHeader, button, divider, firstName, h, p } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// An editorial letter: a left-aligned masthead, a short intro, and three stories.

export const newsletter: GalleryTemplate = {
  id: "newsletter",
  name: "Newsletter",
  description: "A monthly letter with an intro and three short stories.",
  category: "Newsletters",
  subject: 'The October letter for {{ first_name | default: "you" }}',
  preheader: "Three things we learned this month, and one we want to ask you.",
  document: () =>
    brandDocument([
      brandHeader("left", { logoWidth: 120 }),
      h(1, "Three things we learned in October"),
      p(
        "Hi ",
        firstName(),
        ", this month was busy. Here is what changed, what we got wrong, and what comes next. It takes about four minutes to read.",
      ),
      divider(),
      h(2, "We moved our support hours"),
      p(
        "More of you write to us in the evening, so our team now answers until 8 pm. Replies on weekends take one day.",
      ),
      p(a("See the new hours", "https://example.com/support")),
      divider(),
      h(2, "A guide for your first week"),
      p(
        "We wrote a short guide for new members. It covers the setup, the three settings that matter most, and where to ask for help.",
      ),
      p(a("Read the guide", "https://example.com/guide")),
      divider(),
      h(2, "What you told us"),
      p(
        "Last month, 212 of you answered our survey. The top request was a calendar view. We start work on it this week.",
      ),
      button("Read the full letter", "https://example.com/letters/october"),
      p("Thank you for reading. Reply to this email to tell us what you want to see next month."),
      brandFooter("left"),
    ]),
};
