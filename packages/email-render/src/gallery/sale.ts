import { brandFooter, brandHeader, button, columns, h, p, panel, t } from "./parts";
import { brandDocument, type GalleryTemplate } from "./types";

// A time-limited offer: a big panel with the discount and the code, then three picks.

export const sale: GalleryTemplate = {
  id: "sale",
  name: "Sale",
  description: "A time-limited offer with the discount and code up front.",
  category: "Promotions",
  subject: '{{ first_name | default: "Friend" }}, 20% off everything until Sunday',
  preheader: "Use the code AUTUMN20 at checkout. Ends Sunday at midnight.",
  document: () =>
    brandDocument([
      brandHeader("center"),
      panel(
        "primary",
        [
          h(1, "20% off everything"),
          p("Until Sunday at midnight. Use the code ", t("AUTUMN20", "bold"), " at checkout."),
          button("Shop the sale", "https://example.com/sale", { align: "center", tone: "accent" }),
        ],
        { align: "center", padding: 40 },
      ),
      p(
        "Our autumn sale is on. The discount applies to every item, and shipping is free over $40.",
      ),
      h(2, "Popular this week"),
      columns(
        [h(3, "Wool blankets"), p("Warm, soft, and made to last for years.")],
        [h(3, "Stoneware mugs"), p("Each one is glazed by hand in our studio.")],
        [h(3, "Linen aprons"), p("Two pockets and straps you can adjust.")],
      ),
      brandFooter(),
    ]),
};
