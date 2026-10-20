import { expect, type Page } from "@playwright/test";

// The admin app's Content-Security-Policy (public/_headers). Chrome reports each blocked
// script, style, image, font, or request as a console message, also from the srcdoc
// iframes of the previews, which inherit the policy.

const CSP_MESSAGE = /Content[- ]Security[- ]Policy/i;

/**
 * Starts collecting CSP violations. Call the result to check that there were none,
 * apart from those that `expected` matches: a test that clicks a hostile link expects
 * the policy to block it.
 */
export function watchCsp(page: Page): (expected?: RegExp) => void {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (CSP_MESSAGE.test(message.text())) violations.push(message.text());
  });
  return (expected) =>
    expect(
      violations.filter((text) => !expected?.test(text)),
      "Content-Security-Policy violations",
    ).toEqual([]);
}
