import type { DbConnection } from "@envelopen/db";
import { extractLinks, mergeTagNames } from "@envelopen/email-render";
import { getAdapter } from "@envelopen/providers";
import { z } from "zod";
import { readRestoreAck } from "../backup/restore-ack";
import { loadBrand } from "../brand/model";
import { type CampaignPolicy, checkCampaignPolicy } from "../connections/policy-gate";
import { normalizeEmail } from "../contacts/email";
import type { Services } from "../services";
import { verifiedTrackingDomain } from "../templates/preview";
import type { AudienceEstimate } from "./audience";
import { type CampaignRow, isAudienceEmpty, parseAudience } from "./model";

// The pre-send checklist (R33). Prepare runs it before it issues a confirm token, and a
// failed check blocks the send. A warning does not. Each item names the page that fixes it.
//
// Checks: subject, preview text, content, unsubscribe link, the postal address of the
// brand kit (U13), links, From address, domain authentication, audience, connection
// health, the provider policy gate (R62), and an estimate of the D1 writes against the
// Workers Free daily budget (KTD24).

export const CHECK_STATUSES = ["pass", "warn", "fail"] as const;

export const ChecklistItemSchema = z
  .object({
    id: z.enum([
      "subject",
      "preheader",
      "content",
      "unsubscribe_link",
      "postal_address",
      "links",
      "from_address",
      "domain_auth",
      "audience",
      "connection",
      "policy",
      "free_budget",
      "restore",
    ]),
    label: z.string(),
    status: z.enum(CHECK_STATUSES),
    message: z.string(),
    fix: z
      .object({
        label: z.string(),
        path: z.string().meta({ description: "A path in the admin app." }),
      })
      .nullable(),
  })
  .meta({ id: "ChecklistItem" });

export type ChecklistItem = z.output<typeof ChecklistItemSchema>;

/** D1 rows written per recipient and per batch, from the U2 architecture rule (about 3). */
const WRITES_PER_RECIPIENT = 3;
const WRITES_PER_BATCH = 4;

export interface ChecklistInput {
  db: DbConnection;
  services: Partial<Services>;
  campaign: CampaignRow;
  estimate: AudienceEstimate;
}

export interface Checklist {
  items: ChecklistItem[];
  blocked: boolean;
  policy: CampaignPolicy;
}

export async function runChecklist(input: ChecklistInput): Promise<Checklist> {
  const { db, campaign, estimate } = input;
  const workspaceId = campaign.workspace_id;
  const edit = { label: "Edit the campaign", path: `/campaigns/${campaign.id}` };
  const items: ChecklistItem[] = [];
  const html = campaign.html ?? "";

  items.push(
    campaign.subject?.trim()
      ? {
          id: "subject",
          label: "Subject",
          status: "pass",
          message: campaign.subject.trim(),
          fix: null,
        }
      : {
          id: "subject",
          label: "Subject",
          status: "fail",
          message: "The campaign has no subject.",
          fix: edit,
        },
  );
  items.push(
    campaign.preheader?.trim()
      ? {
          id: "preheader",
          label: "Preview text",
          status: "pass",
          message: campaign.preheader.trim(),
          fix: null,
        }
      : {
          id: "preheader",
          label: "Preview text",
          status: "warn",
          message: "No preview text. Inboxes show the first line of the email instead.",
          fix: campaign.template_id
            ? { label: "Edit the template", path: `/templates/${campaign.template_id}` }
            : edit,
        },
  );
  items.push(
    html.trim()
      ? {
          id: "content",
          label: "Content",
          status: "pass",
          message: "The email has content.",
          fix: null,
        }
      : {
          id: "content",
          label: "Content",
          status: "fail",
          message: "Choose a template for the campaign.",
          fix: edit,
        },
  );

  const tags = new Set(mergeTagNames(html));
  const templateFix = campaign.template_id
    ? { label: "Edit the template", path: `/templates/${campaign.template_id}` }
    : edit;
  items.push(
    tags.has("unsubscribe_url") || tags.has("preferences_url")
      ? {
          id: "unsubscribe_link",
          label: "Unsubscribe link",
          status: "pass",
          message:
            "The email has an unsubscribe link, and every message gets the one-click headers.",
          fix: null,
        }
      : {
          id: "unsubscribe_link",
          label: "Unsubscribe link",
          status: "fail",
          message: "Add an unsubscribe link, for example the footer block, to the email.",
          fix: templateFix,
        },
  );

  // Anti-spam laws (for example CAN-SPAM) ask for the sender's postal address in each
  // campaign. The brand footer block shows it, and confirm stores it in the snapshot.
  const address = (await loadBrand(db, workspaceId)).kit?.postal_address.trim() ?? "";
  items.push(
    address
      ? {
          id: "postal_address",
          label: "Postal address",
          status: "pass",
          message: address.split("\n")[0] ?? address,
          fix: null,
        }
      : {
          id: "postal_address",
          label: "Postal address",
          status: "fail",
          message:
            "Campaigns need your postal address, and the brand kit has none. Add it in Brand, then check the send again.",
          fix: { label: "Add the postal address in Brand", path: "/brand" },
        },
  );

  const links = extractLinks(html);
  const insecure = links.filter((url) => url.toLowerCase().startsWith("http://"));
  items.push(
    insecure.length > 0
      ? {
          id: "links",
          label: "Links",
          status: "warn",
          message: `${insecure.length} of ${links.length} links use http, not https.`,
          fix: templateFix,
        }
      : {
          id: "links",
          label: "Links",
          status: "pass",
          message:
            links.length === 0
              ? "No links to track."
              : links.length === 1
                ? "1 link, https."
                : `${links.length} links, all https.`,
          fix: null,
        },
  );

  const from = campaign.from_email ? normalizeEmail(campaign.from_email) : null;
  const fromDomain = from?.split("@")[1];
  const domain = fromDomain
    ? await db.db
        .selectFrom("sending_domains")
        .select(["id", "domain", "verified_at", "tracking_domain", "tracking_status"])
        .where("workspace_id", "=", workspaceId)
        .where("domain", "=", fromDomain)
        .executeTakeFirst()
    : undefined;
  if (!from) {
    items.push({
      id: "from_address",
      label: "From address",
      status: "fail",
      message: "Set the From address.",
      fix: edit,
    });
  } else if (!domain) {
    items.push({
      id: "from_address",
      label: "From address",
      status: "fail",
      message: `${fromDomain} is not a sending domain of this workspace.`,
      fix: { label: "Add the domain", path: "/connections/domains" },
    });
  } else {
    items.push({
      id: "from_address",
      label: "From address",
      status: "pass",
      message: from,
      fix: null,
    });
  }
  // A tracking domain that does not pass its check is not used. Links stay on the app's
  // host (linkOrigin in operations.ts). That is a warning, not a block.
  const unverifiedTracking =
    domain?.tracking_domain && !verifiedTrackingDomain(domain) ? domain.tracking_domain : null;
  items.push(
    domain?.verified_at
      ? unverifiedTracking
        ? {
            id: "domain_auth",
            label: "Domain authentication",
            status: "warn",
            message:
              `SPF, DKIM, and DMARC pass for ${domain.domain}. The tracking domain ` +
              `${unverifiedTracking} does not pass its check, so links use the app address.`,
            fix: { label: "Check the DNS records", path: `/connections/domains/${domain.id}` },
          }
        : {
            id: "domain_auth",
            label: "Domain authentication",
            status: "pass",
            message: `SPF, DKIM, and DMARC pass for ${domain.domain}.`,
            fix: null,
          }
      : {
          id: "domain_auth",
          label: "Domain authentication",
          status: "fail",
          message: domain
            ? `${domain.domain} does not pass SPF, DKIM, and DMARC yet.`
            : "The From address needs an authenticated sending domain.",
          fix: domain
            ? { label: "Check the DNS records", path: `/connections/domains/${domain.id}` }
            : { label: "Add a sending domain", path: "/connections/domains" },
        },
  );

  const audience = parseAudience(campaign.audience);
  const leftOut = estimate.excluded.consent_unknown;
  items.push(
    isAudienceEmpty(audience)
      ? {
          id: "audience",
          label: "Audience",
          status: "fail",
          message: "Choose at least one list or tag.",
          fix: edit,
        }
      : estimate.recipients === 0
        ? {
            id: "audience",
            label: "Audience",
            status: "fail",
            message:
              leftOut > 0 && campaign.type === "regular"
                ? `No contact can get this campaign. ${leftOut} contacts have unknown consent: they get only a re-permission campaign.`
                : "No contact in the audience can get this campaign.",
            fix: edit,
          }
        : {
            id: "audience",
            label: "Audience",
            status: "pass",
            message: `About ${estimate.recipients} recipients.`,
            fix: null,
          },
  );

  const policy = await checkCampaignPolicy(db, workspaceId);
  const connections = { label: "Open connections", path: "/connections" };
  if (!policy.allowed && policy.code !== "policy_warning") {
    items.push({
      id: "connection",
      label: "Provider connection",
      status: "fail",
      message: policy.message,
      fix: connections,
    });
    items.push({
      id: "policy",
      label: "Provider policy",
      status: "fail",
      message: "Connect a provider that permits campaigns.",
      fix: connections,
    });
  } else {
    const row = policy.connectionId
      ? await db.db
          .selectFrom("provider_connections")
          .select(["name", "provider"])
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", policy.connectionId)
          .executeTakeFirst()
      : undefined;
    const providerName = row ? (getAdapter(row.provider)?.name ?? row.provider) : "";
    const name = !row
      ? "The connection"
      : row.name.toLowerCase() === providerName.toLowerCase() || row.name === row.provider
        ? providerName
        : `${row.name} (${providerName})`;
    items.push({
      id: "connection",
      label: "Provider connection",
      status: "pass",
      message: `${name} is active.`,
      fix: null,
    });
    items.push(
      policy.allowed
        ? {
            id: "policy",
            label: "Provider policy",
            status: "pass",
            message: "The provider permits campaigns.",
            fix: null,
          }
        : {
            id: "policy",
            label: "Provider policy",
            status: "fail",
            message: policy.message,
            fix: connections,
          },
    );
  }

  items.push(await budgetItem(input, policy));
  const restore = await readRestoreAck(db);
  if (restore) {
    items.push({
      id: "restore",
      label: "Restored data",
      status: "fail",
      message:
        "This deployment was restored from a backup. Unsubscribes after the backup are missing. Confirm the age of the backup before you send.",
      fix: { label: "Open the backup settings", path: "/settings#backups" },
    });
  }
  return { items, blocked: items.some((item) => item.status === "fail"), policy };
}

async function budgetItem(input: ChecklistInput, policy: CampaignPolicy): Promise<ChecklistItem> {
  const provider = policy.allowed ? getAdapter(policy.provider) : undefined;
  const batchSize = provider?.capabilities.batchSize ?? 50;
  const recipients = input.estimate.recipients;
  const n = (value: number) => value.toLocaleString("en-US");
  const writes =
    recipients * WRITES_PER_RECIPIENT + Math.ceil(recipients / batchSize) * WRITES_PER_BATCH;
  const base = { id: "free_budget" as const, label: "Workers Free budget", fix: null };
  const usage = input.services.usage;
  if (!usage) {
    return {
      ...base,
      status: "warn",
      message: `About ${n(writes)} D1 writes. The daily usage is not available.`,
    };
  }
  try {
    const status = await usage.status();
    if (status.platformLimit && status.platformLimit.until > Date.now()) {
      return {
        ...base,
        status: "warn",
        message: "D1 reached its daily write limit. Sending waits until 00:00 UTC.",
      };
    }
    const left = Math.max(0, status.dailyLimit - status.rowsWritten);
    if (writes > left) {
      return {
        ...base,
        status: "warn",
        message: `About ${n(writes)} D1 writes, and ${n(left)} are left today on Workers Free. The campaign pauses at the limit and resumes after 00:00 UTC. Workers Paid has no daily limit.`,
      };
    }
    return {
      ...base,
      status: "pass",
      message: `About ${n(writes)} D1 writes, and ${n(left)} are left today.`,
    };
  } catch {
    return {
      ...base,
      status: "warn",
      message: `About ${n(writes)} D1 writes. The daily usage is not available.`,
    };
  }
}
