import type { OutgoingMessage } from "../../src/types";

// Sample messages that every adapter fixture sends. Each one is a campaign message
// with both unsubscribe headers, as U9 builds them.

export function campaignMessage(index: number): OutgoingMessage {
  return {
    recipientId: `r${index}`,
    kind: "campaign",
    from: "Course Academy <news@mail.example.com>",
    to: `student${index}@example.org`,
    replyTo: "hello@example.com",
    subject: "A new course starts Monday",
    html: `<p>Hello student ${index}</p>`,
    text: `Hello student ${index}`,
    headers: {
      "List-Unsubscribe": `<https://track.example.com/u/token${index}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export function campaignBatch(size: number): OutgoingMessage[] {
  return Array.from({ length: size }, (_, index) => campaignMessage(index + 1));
}
