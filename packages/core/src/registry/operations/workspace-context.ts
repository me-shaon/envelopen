import { z } from "zod";
import { CONFIRM_TOKEN_TTL_MS } from "../../campaigns/model";
import { ConnectionSchema } from "../../connections/model";
import { connectionsList } from "../../connections/operations";
import { CONSENT_BASES } from "../../contacts/model";
import { domainsList, SendingDomainSchema } from "../../domains/operations";
import { API_KEY_SCOPES } from "../../scopes";
import { usageGet } from "../../usage/operations";
import { UsageSchema } from "../../usage/view";
import { defineOperation } from "../operation";
import { workspacesGet } from "./workspaces";

// The first call of an agent (U16, KTD11). One read gives the facts that decide what the
// agent can do: the provider status, domain authentication, tracking settings, the usage
// budget, the consent vocabulary, and how prepare and confirm work. It reads the same
// handlers as the single operations, so the facts match the admin app.

const CONSENT_MEANINGS: Readonly<Record<(typeof CONSENT_BASES)[number], string>> = {
  existing_customer: "The contact bought from or signed up with the sender. Regular campaigns.",
  explicit_opt_in: "The contact asked for email. Regular campaigns.",
  unknown: "No known basis. Only re-permission campaigns reach the contact.",
};

const CONSENT_RULES = [
  "An API key or MCP client can lower a consent basis but cannot raise it from unknown. Only the owner can.",
  "Unsubscribed and suppressed contacts never receive a campaign. Imports and upserts do not clear an unsubscribe.",
  "A re-permission campaign is the only campaign type that includes contacts with the unknown basis.",
];

const SENDING_RULES = [
  "Sending takes two steps on every surface. campaigns_prepare runs the checklist and returns a confirm token when no check fails.",
  "campaigns_confirm spends the token. The token works once, for the same API key, for the campaign version and mode that prepare saw.",
  `A confirm token expires after ${CONFIRM_TOKEN_TTL_MS / 60_000} minutes. An edit to the campaign makes it stale. Prepare again in both cases.`,
  "The recipient count from prepare is an estimate. The recipient list is taken when the send starts.",
  "campaigns_send_test sends to the test addresses that the owner set up. It does not need a token.",
  "Write tools accept an idempotencyKey. A retry with the same key and the same arguments returns the first result and does not run again.",
];

const CheckStatusSchema = SendingDomainSchema.shape.spf;

export const WorkspaceContextSchema = z
  .object({
    workspace: z.object({
      id: z.number().int(),
      name: z.string(),
      trackingOpens: z.boolean().meta({ description: "Default for new campaigns." }),
      trackingClicks: z.boolean().meta({ description: "Default for new campaigns." }),
      eventRetentionDays: z.number().int(),
    }),
    access: z.object({
      scopes: z
        .array(z.enum(API_KEY_SCOPES))
        .meta({ description: "The scopes of the caller. Tools outside them are hidden." }),
    }),
    provider: z.object({
      ready: z.boolean().meta({
        description: "A connection is selected and active, so campaigns and test sends can go out.",
      }),
      connections: z.array(ConnectionSchema),
    }),
    domains: z.array(
      z.object({
        id: z.number().int(),
        domain: z.string(),
        status: SendingDomainSchema.shape.status,
        spf: CheckStatusSchema,
        dkim: CheckStatusSchema,
        dmarc: CheckStatusSchema,
        trackingDomain: z.string().nullable(),
        tracking: CheckStatusSchema,
      }),
    ),
    usage: UsageSchema.nullable().meta({
      description: "The daily platform budget. Null when the usage counter did not answer.",
    }),
    consent: z.object({
      bases: z.array(z.object({ basis: z.enum(CONSENT_BASES), meaning: z.string() })),
      rules: z.array(z.string()),
    }),
    sending: z.object({
      confirmTokenTtlMs: z.number().int(),
      rules: z.array(z.string()),
    }),
  })
  .meta({ id: "WorkspaceContext" });

export const workspaceContextGet = defineOperation({
  id: "workspace_context.get",
  summary: "Get the workspace context for an agent",
  description:
    "Call this first. Returns the provider status, domain authentication, tracking settings, " +
    "the usage budget, the consent vocabulary, and how prepare and confirm work. No secrets.",
  method: "get",
  path: "/workspace/context",
  scope: "stats:read",
  risk: "read",
  mcp: {
    class: "now",
    reason: "The plan's U16 context tool. Agents read the rules before they act.",
    tool: "get_workspace_context",
  },
  input: z.object({}),
  output: WorkspaceContextSchema,
  async handler(_input, ctx) {
    const [workspace, connections, domains, usage] = await Promise.all([
      workspacesGet.handler({}, ctx),
      connectionsList.handler({}, ctx),
      domainsList.handler({}, ctx),
      // The usage counter is a Durable Object. Its failure must not hide the other facts.
      usageGet.handler({}, ctx).catch(() => null),
    ]);
    const selected = connections.items.find((connection) => connection.selected);
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        trackingOpens: workspace.trackingOpens,
        trackingClicks: workspace.trackingClicks,
        eventRetentionDays: workspace.eventRetentionDays,
      },
      access: {
        scopes: API_KEY_SCOPES.filter((scope) => ctx.principal.scopes.has(scope)),
      },
      provider: {
        ready: selected?.status === "active",
        connections: connections.items,
      },
      domains: domains.items.map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        status: domain.status,
        spf: domain.spf,
        dkim: domain.dkim,
        dmarc: domain.dmarc,
        trackingDomain: domain.trackingDomain,
        tracking: domain.tracking,
      })),
      usage,
      consent: {
        bases: CONSENT_BASES.map((basis) => ({ basis, meaning: CONSENT_MEANINGS[basis] })),
        rules: CONSENT_RULES,
      },
      sending: { confirmTokenTtlMs: CONFIRM_TOKEN_TTL_MS, rules: SENDING_RULES },
    };
  },
});
