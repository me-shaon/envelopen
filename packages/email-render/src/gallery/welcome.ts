import { brandFooter, brandHeader, button, columns, firstName, h, p, spacer } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// The first email after a signup: a warm hello, three first steps, and a person to reply to.

export const welcome: GalleryTemplate = {
  id: "welcome",
  name: "Welcome email",
  description: "A warm hello with three first steps for a new subscriber.",
  category: "Onboarding",
  subject: 'Welcome, {{ first_name | default: "friend" }}',
  preheader: "Thank you for joining. Here is how to start.",
  document: () =>
    brandDocument([
      brandHeader("center"),
      h(1, "Hi ", firstName(), ","),
      p(
        "Thank you for joining. We are glad to have you here. Over the next days, we will send you a few short emails to help you get started.",
      ),
      spacer(8),
      columns(
        [h(3, "Set up"), p("Add your name and photo, so the team knows who you are.")],
        [h(3, "Explore"), p("Open the guide and try one thing that looks useful.")],
        [h(3, "Ask"), p("Reply to any email. A person reads every reply.")],
      ),
      button("Get started", "https://example.com/start"),
      p("See you soon."),
      brandFooter(),
    ]),
};
