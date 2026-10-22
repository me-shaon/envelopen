import { brandFooter, brandHeader, button, columns, firstName, h, p, panel } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// A one-question survey: the reader answers with one click on one of three buttons.

export const survey: GalleryTemplate = {
  id: "survey",
  name: "Survey",
  description: "One question with a one-click answer.",
  category: "Feedback",
  subject: "One question, one click",
  preheader: "How likely are you to recommend us to a friend?",
  document: () =>
    brandDocument([
      brandHeader("center"),
      h(1, "How are we doing?"),
      p(
        "Hi ",
        firstName(),
        ", we have one question. Click a number to answer. It takes one second, and it helps us a lot.",
      ),
      panel("tint", [
        h(3, "How likely are you to recommend us to a friend?"),
        columns(
          [button("Not likely", "https://example.com/survey?answer=no", { tone: "accent" })],
          [button("Maybe", "https://example.com/survey?answer=maybe", { tone: "accent" })],
          [button("Very likely", "https://example.com/survey?answer=yes", { tone: "accent" })],
        ),
      ]),
      p("Do you have more to say? The full survey has five short questions."),
      button("Answer the full survey", "https://example.com/survey/full"),
      p("Thank you. We read every answer."),
      brandFooter(),
    ]),
};
