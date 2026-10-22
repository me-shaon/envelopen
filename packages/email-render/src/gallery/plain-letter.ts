import { brandFooter, brandHeader, firstName, p, t } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// A personal note: text only, like an email from a person, with a small logo on top.

export const plainLetter: GalleryTemplate = {
  id: "plain-letter",
  name: "Plain letter",
  description: "A personal note with text only, like an email from a person.",
  category: "Newsletters",
  subject: "A short note from the founder",
  preheader: "Why we are changing how we work next year.",
  document: () =>
    brandDocument([
      brandHeader("left", { showName: false, logoWidth: 72 }),
      p("Hi ", firstName(), ","),
      p(
        "I want to tell you about a change before you read about it anywhere else. From January, we close the office on Fridays. The team works four days a week.",
      ),
      p(
        "We tried this for three months. We answered your emails just as fast, and we made fewer mistakes. So we keep it.",
      ),
      p(
        "Nothing changes for you. Support still answers every day, and your plan and price stay the same.",
      ),
      p(
        "If you have a question or a worry about this, reply to this email. I read every reply myself.",
      ),
      p("Thank you for being with us."),
      p(t("Maya", "bold"), { type: "hardBreak" }, "Founder"),
      brandFooter("left"),
    ]),
};
