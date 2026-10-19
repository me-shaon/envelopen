import type { BufferedEvent } from "@envelopen/core";

// Clients of the EventBuffer Durable Object (do/event-buffer.ts). They live apart from
// the class, so modules that Node.js also loads do not import `cloudflare:workers`.

export function eventBufferName(workspaceId: number): string {
  return `workspace:${workspaceId}`;
}

export function eventBuffer(env: Pick<Env, "EVENT_BUFFER">, workspaceId: number) {
  return env.EVENT_BUFFER.getByName(eventBufferName(workspaceId));
}

/** What the tracking routes and webhooks need: hand events of one workspace to its buffer. */
export type EventSink = (workspaceId: number, events: BufferedEvent[]) => Promise<void>;

export function eventSink(env: Pick<Env, "EVENT_BUFFER">): EventSink {
  return async (workspaceId, events) => {
    if (events.length === 0) return;
    await eventBuffer(env, workspaceId).add(workspaceId, events);
  };
}
