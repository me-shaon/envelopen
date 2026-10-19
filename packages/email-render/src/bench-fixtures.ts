import type { Recipient } from "./personalize";

// Sample input for the personalization benchmark: the local test and the deployed
// benchmark Worker in apps/worker/scripts/personalize-benchmark use the same data.

/**
 * A newsletter of about 40 KB with 20 links, near the size of a long React Email
 * template, with merge tags, mailto, and the footer placeholders.
 */
export function sampleEmail(): string {
  const section = (i: number) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tbody><tr><td style="padding:0 0 12px">` +
    `<h2 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#1a1917;font-weight:600">Lesson ${i}: {{ course | default: "your course" }}</h2>` +
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1917">${"Practice makes the ideas stick. Here is a short exercise for this week, with a worked answer and two extra problems. ".repeat(28)}</p>` +
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1917"><a href="https://example.com/lessons/${i}?utm_source=newsletter&amp;utm_medium=email" style="color:#4a3c77">Open lesson ${i}</a> or <a href="https://example.com/forum/${i}" style="color:#4a3c77">ask in the forum</a>.</p>` +
    `</td></tr></tbody></table>`;
  return (
    `<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><style>body{margin:0}</style></head>` +
    `<body class="env-page" style="margin:0;background:#f6f5f2"><table role="presentation" width="600" align="center"><tbody><tr><td style="padding:36px 40px">` +
    `<h1 style="margin:0 0 12px;font-size:28px">Hello {{ first_name | default: &quot;there&quot; }}</h1>` +
    Array.from({ length: 10 }, (_, i) => section(i + 1)).join("") +
    `<p>Questions? <a href="mailto:help@example.com">Write to us</a>.</p>` +
    `<p style="font-size:13px;color:#6b675f"><a href="{{ unsubscribe_url }}">Unsubscribe</a> · <a href="{{ preferences_url }}">Email preferences</a></p>` +
    `</td></tr></tbody></table></body></html>`
  );
}

/** The default batch of 50 recipients (KTD20). */
export function sampleBatch(size = 50): Recipient[] {
  return Array.from({ length: size }, (_, i) => ({
    campaignId: 7,
    recipientId: 1000 + i,
    fields: {
      email: `student${i}@example.com`,
      first_name: i % 5 === 0 ? null : `Student <${i}>`,
      last_name: "Silva",
      course: i % 3 === 0 ? "" : "Intro to Data",
    },
  }));
}
