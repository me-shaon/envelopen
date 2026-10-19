import { describe, expect, it } from "vitest";
import { testKey } from "../test/keys";
import { sampleBatch, sampleEmail } from "./bench-fixtures";
import { personalize, prepareMessage, type Recipient } from "./personalize";
import { createTokenSigner } from "./tokens";

const ORIGIN = "https://t.example.com";

async function setup(tracking: boolean) {
  const signer = await createTokenSigner([{ secret: testKey(3) }]);
  const prepared = prepareMessage({
    html: sampleEmail(),
    subject: 'Week 3 for {{ first_name | default: "you" }}',
    text: "Hi {{ first_name }}. Unsubscribe: {{ unsubscribe_url }}",
    trackingOrigin: `${ORIGIN}/`,
    trackOpens: tracking,
    trackClicks: tracking,
  });
  return { signer, prepared };
}

describe("personalize (KTD26)", () => {
  it("references each link by index under one signed token per recipient", async () => {
    const { signer, prepared } = await setup(true);
    expect(prepared.links).toHaveLength(20);
    expect(prepared.links[0]).toBe(
      "https://example.com/lessons/1?utm_source=newsletter&utm_medium=email",
    );
    const recipient = sampleBatch(1)[0] as Recipient;
    const out = await personalize(prepared, recipient, signer);
    const token = await signer.sign(recipient);
    const hrefs = [...out.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      `${ORIGIN}/t/h/${token}`,
      ...prepared.links.map((_, index) => `${ORIGIN}/t/c/${token}/${index}`),
      "mailto:help@example.com",
      `${ORIGIN}/u/${token}`,
      `${ORIGIN}/u/${token}/preferences`,
    ]);
    expect(out.html).toContain(`<img src="${ORIGIN}/t/o/${token}" width="1" height="1"`);
    expect(out.html.indexOf("/t/o/")).toBeLessThan(out.html.indexOf("</body>"));
    expect(out.headers["List-Unsubscribe"]).toBe(`<${ORIGIN}/u/${token}>`);
    expect(out.subject).toBe("Week 3 for you");
    expect(out.text).toBe(`Hi . Unsubscribe: ${ORIGIN}/u/${token}`);
  });

  it("escapes contact data and uses fallbacks", async () => {
    const { signer, prepared } = await setup(true);
    const second = sampleBatch(2)[1] as Recipient;
    const out = await personalize(prepared, second, signer);
    expect(out.html).toContain("Hello Student &lt;1&gt;</h1>");
    expect(out.html).toContain("Lesson 1: Intro to Data");
    expect(out.subject).toBe("Week 3 for Student <1>");
  });

  it("gives byte-identical output when the same batch is personalized twice", async () => {
    const { signer, prepared } = await setup(true);
    const again = await setup(true);
    const batch = sampleBatch();
    const first = await Promise.all(batch.map((r) => personalize(prepared, r, signer)));
    const second = await Promise.all(
      batch.map((r) => personalize(again.prepared, r, again.signer)),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(new Set(first.map((m) => m.html)).size).toBe(50);
  });

  it("adds no pixel and rewrites no links when tracking is off", async () => {
    const { signer, prepared } = await setup(false);
    expect(prepared.links).toEqual([]);
    const out = await personalize(prepared, sampleBatch(1)[0] as Recipient, signer);
    expect(out.html).not.toContain("/t/");
    expect(out.html).toContain('href="https://example.com/forum/1"');
    expect(out.html).toContain(`${ORIGIN}/u/`);
  });
});
