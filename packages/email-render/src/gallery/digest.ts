import { a, brandFooter, brandHeader, divider, firstName, h, p, t } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// A compact weekly roundup: short items, each title a link, with the source below.

const item = (title: string, summary: string, source: string, href: string) => [
  h(3, a(title, href)),
  p(`${summary} `, t(source, "italic")),
];

export const digest: GalleryTemplate = {
  id: "digest",
  name: "Weekly digest",
  description: "A compact roundup of short items, each with one link.",
  category: "Newsletters",
  subject: "Your weekly digest: five short reads",
  preheader: "The best of the week in five minutes.",
  document: () =>
    brandDocument([
      brandHeader("left", { logoWidth: 110 }),
      h(2, "Your weekly digest"),
      p("Hi ", firstName(), ". Here are five short reads we liked this week."),
      divider(),
      ...item(
        "How to plan a week you can keep",
        "Plan three things, not ten. The rest is a bonus.",
        "From the blog, 4 min",
        "https://example.com/reads/1",
      ),
      ...item(
        "A checklist for your first hire",
        "What to write down before you post the job.",
        "From a member, 6 min",
        "https://example.com/reads/2",
      ),
      ...item(
        "Why small teams ship faster",
        "Fewer handoffs mean fewer delays.",
        "From the podcast, 22 min",
        "https://example.com/reads/3",
      ),
      ...item(
        "Five templates for meeting notes",
        "Copy the one that fits your team.",
        "From the guide, 3 min",
        "https://example.com/reads/4",
      ),
      ...item(
        "The question we get most",
        "And the short answer we give every time.",
        "From support, 2 min",
        "https://example.com/reads/5",
      ),
      brandFooter("left"),
    ]),
};
