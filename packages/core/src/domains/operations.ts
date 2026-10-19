import type { DbConnection, Row } from "@envelopen/db";
import { type DnsRecordHint, getAdapter, type ProviderAdapter } from "@envelopen/providers";
import { z } from "zod";
import { adapterContext, decryptCredentials, parseJson, refsOf } from "../connections/model";
import { sendingConnection } from "../connections/policy-gate";
import { OperationError } from "../errors";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import {
  type CheckResult,
  type CheckStatus,
  checkDkim,
  checkDmarc,
  checkSpf,
  checkTracking,
  createDohClient,
  type ExpectedDkim,
} from "./dns-check";

// Sending domains (R12, R13). The owner adds the domain that emails come from, copies
// the DNS records, and Envelopen checks them over DNS over HTTPS. A domain is verified
// when SPF, DKIM, and DMARC pass. The tracking domain is optional.
//
// Reading the status is open to keys with stats:read and to MCP (the plan's "domain
// status"). Adding, changing, and checking a domain is owner work in the admin app.

type DomainRow = Row<"sending_domains">;

const STATUSES = ["unknown", "pass", "missing", "fail", "error"] as const;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SELECTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

const CheckSchema = z.object({ status: z.enum(STATUSES), detail: z.string().nullable() });

const RecordSchema = z
  .object({
    purpose: z.enum(["spf", "dkim", "dmarc", "return_path", "tracking"]),
    type: z.enum(["TXT", "CNAME", "MX"]),
    host: z.string(),
    value: z
      .string()
      .nullable()
      .meta({ description: "Null when the provider dashboard shows the value." }),
    note: z.string().nullable(),
  })
  .meta({ id: "DnsRecord" });

type DnsRecord = z.output<typeof RecordSchema>;

export const SendingDomainSchema = z
  .object({
    id: z.number().int(),
    domain: z.string(),
    status: z.enum(["verified", "pending", "failed"]),
    connectionId: z.number().int().nullable(),
    spf: CheckSchema,
    dkim: CheckSchema,
    dmarc: CheckSchema,
    trackingDomain: z.string().nullable(),
    tracking: CheckSchema,
    dkimSelectors: z.array(z.string()),
    records: z.array(RecordSchema),
    lastCheckedAt: z.number().int().nullable(),
    verifiedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
  })
  .meta({ id: "SendingDomain" });

type Detail = Partial<Record<"spf" | "dkim" | "dmarc" | "tracking", string>>;

function statusOf(value: string): CheckStatus {
  return (STATUSES as readonly string[]).includes(value) ? (value as CheckStatus) : "unknown";
}

function toDomain(row: DomainRow): z.input<typeof SendingDomainSchema> {
  const detail = parseJson<Detail>(row.check_detail, {});
  const checks = {
    spf: { status: statusOf(row.spf_status), detail: detail.spf ?? null },
    dkim: { status: statusOf(row.dkim_status), detail: detail.dkim ?? null },
    dmarc: { status: statusOf(row.dmarc_status), detail: detail.dmarc ?? null },
  };
  const failed = Object.values(checks).some((check) => check.status === "fail");
  return {
    id: row.id,
    domain: row.domain,
    status: row.verified_at !== null ? "verified" : failed ? "failed" : "pending",
    connectionId: row.connection_id,
    ...checks,
    trackingDomain: row.tracking_domain,
    tracking: { status: statusOf(row.tracking_status), detail: detail.tracking ?? null },
    dkimSelectors: parseJson<string[]>(row.dkim_selectors, []),
    records: parseJson<DnsRecord[]>(row.records, []),
    lastCheckedAt: row.last_checked_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

function normalizeDomain(value: string, label: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_PATTERN.test(domain))
    throw new OperationError("invalid_input", `${label} is not a valid domain name.`);
  return domain;
}

function appHost(ctx: OperationContext): string | null {
  return ctx.services.appOrigin ? new URL(ctx.services.appOrigin).host.toLowerCase() : null;
}

/**
 * The records to add: the provider's own list when its API has one, and defaults
 * from the adapter's DNS hints otherwise. DMARC and tracking are Envelopen's.
 */
async function recordsFor(
  ctx: OperationContext,
  domain: string,
  selectors: readonly string[],
  trackingDomain: string | null,
): Promise<DnsRecord[]> {
  const connection = await sendingConnection(ctx.db, ctx.principal.workspaceId);
  const adapter: ProviderAdapter | undefined = connection
    ? getAdapter(connection.provider)
    : undefined;
  let fromProvider: DnsRecordHint[] | null = null;
  if (connection && adapter?.domainRecords) {
    try {
      fromProvider = await adapter.domainRecords(
        await decryptCredentials(ctx.services, connection),
        domain,
        adapterContext(ctx.services, refsOf(connection)),
      );
    } catch {
      fromProvider = null;
    }
  }
  const name = adapter?.name ?? "your provider";
  const records: DnsRecord[] = fromProvider
    ? fromProvider.map((record) => ({ ...record, note: null }))
    : [];
  if (!records.some((record) => record.purpose === "spf") && adapter?.dns.spfInclude) {
    records.push({
      purpose: "spf",
      type: "TXT",
      host: adapter.dns.spfHost?.(domain) ?? domain,
      value: `v=spf1 include:${adapter.dns.spfInclude} ~all`,
      note: "If the host has an SPF record already, add the include to it. A host can have only one.",
    });
  }
  if (!records.some((record) => record.purpose === "dkim")) {
    const list = selectors.length > 0 ? selectors : (adapter?.dns.dkimSelectors ?? []);
    for (const selector of list) {
      records.push({
        purpose: "dkim",
        type: "TXT",
        host: `${selector}._domainkey.${domain}`,
        value: null,
        note: `Copy the DKIM value from ${name}.`,
      });
    }
    if (list.length === 0) {
      records.push({
        purpose: "dkim",
        type: "TXT",
        host: `<selector>._domainkey.${domain}`,
        value: null,
        note: `Copy the DKIM record from ${name}, then add its selector here so Envelopen can check it.`,
      });
    }
  }
  records.push({
    purpose: "dmarc",
    type: "TXT",
    host: `_dmarc.${domain}`,
    value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
    note: "Start with p=none. Move to quarantine once reports look clean.",
  });
  if (trackingDomain) {
    records.push({
      purpose: "tracking",
      type: "CNAME",
      host: trackingDomain,
      value: appHost(ctx),
      note: "Or add the host as a Workers custom domain of this Worker, in the same Cloudflare account.",
    });
  }
  return records;
}

interface Checks {
  spf: CheckResult;
  dkim: CheckResult;
  dmarc: CheckResult;
  tracking: CheckResult;
}

async function runChecks(
  ctx: OperationContext,
  row: DomainRow,
  records: readonly DnsRecord[],
): Promise<Checks> {
  const fetcher = requireService(ctx.services, "outboundFetch");
  const doh = createDohClient(fetcher);
  const connection = await sendingConnection(ctx.db, ctx.principal.workspaceId);
  const adapter = connection ? getAdapter(connection.provider) : undefined;
  const spfRecord = records.find((record) => record.purpose === "spf");
  const spfHosts = [...new Set([row.domain, ...(spfRecord ? [spfRecord.host] : [])])];
  const dkim: ExpectedDkim[] = records
    .filter((record) => record.purpose === "dkim" && !record.host.startsWith("<"))
    .map((record) => ({
      host: record.host,
      type: record.type === "CNAME" ? "CNAME" : "TXT",
      ...(record.type === "CNAME" && record.value ? { value: record.value } : {}),
    }));
  const [spf, dkimResult, dmarc, tracking] = await Promise.all([
    checkSpf(doh, spfHosts, adapter?.dns.spfInclude ?? null),
    checkDkim(doh, dkim),
    checkDmarc(doh, row.domain),
    checkTracking(doh, fetcher, row.tracking_domain, appHost(ctx)),
  ]);
  return { spf, dkim: dkimResult, dmarc, tracking };
}

async function saveChecks(
  ctx: OperationContext,
  row: DomainRow,
  records: DnsRecord[],
  checks: Checks,
) {
  const verified =
    checks.spf.status === "pass" && checks.dkim.status === "pass" && checks.dmarc.status === "pass";
  const detail: Detail = {
    spf: checks.spf.detail,
    dkim: checks.dkim.detail,
    dmarc: checks.dmarc.detail,
    tracking: checks.tracking.detail,
  };
  return ctx.db.db
    .updateTable("sending_domains")
    .set({
      spf_status: checks.spf.status,
      dkim_status: checks.dkim.status,
      dmarc_status: checks.dmarc.status,
      tracking_status: checks.tracking.status,
      check_detail: JSON.stringify(detail),
      records: JSON.stringify(records),
      last_checked_at: ctx.now,
      verified_at: verified ? (row.verified_at ?? ctx.now) : null,
      updated_at: ctx.now,
    })
    .where("workspace_id", "=", ctx.principal.workspaceId)
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function loadDomain(db: DbConnection, workspaceId: number, id: number): Promise<DomainRow> {
  const row = await db.db
    .selectFrom("sending_domains")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The domain does not exist.");
  return row;
}

async function recheck(ctx: OperationContext, row: DomainRow) {
  const records = await recordsFor(
    ctx,
    row.domain,
    parseJson<string[]>(row.dkim_selectors, []),
    row.tracking_domain,
  );
  return saveChecks(ctx, row, records, await runChecks(ctx, row, records));
}

const idInput = z.object({ id: z.coerce.number().int().positive() });
const ADMIN_ONLY = {
  class: "never",
  reason: "Domain setup is owner work in the admin app. Agents read the status.",
} as const;

const selectorsInput = z
  .array(
    z
      .string()
      .trim()
      .regex(SELECTOR_PATTERN, "A DKIM selector has letters, digits, dots, and dashes."),
  )
  .max(5);

export const domainsList = defineOperation({
  id: "domains.list",
  summary: "List sending domains",
  description: "Returns the sending domains of the workspace with the status of each DNS check.",
  method: "get",
  path: "/domains",
  scope: "stats:read",
  risk: "read",
  mcp: { class: "now", reason: "Read access to domain status is in the plan's MCP 'now' set." },
  input: z.object({}),
  output: z.object({ items: z.array(SendingDomainSchema) }).meta({ id: "SendingDomainList" }),
  async handler(_input, { principal, db }) {
    const rows = await db.db
      .selectFrom("sending_domains")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .orderBy("id", "asc")
      .execute();
    return { items: rows.map(toDomain) };
  },
});

export const domainsGet = defineOperation({
  id: "domains.get",
  summary: "Get a sending domain",
  description: "Returns a domain with the DNS records to add and the result of the last check.",
  method: "get",
  path: "/domains/{id}",
  scope: "stats:read",
  risk: "read",
  mcp: { class: "now", reason: "Read access to domain status is in the plan's MCP 'now' set." },
  input: idInput,
  output: SendingDomainSchema,
  async handler(input, { principal, db }) {
    return toDomain(await loadDomain(db, principal.workspaceId, input.id));
  },
});

export const domainsCreate = defineOperation({
  id: "domains.create",
  summary: "Add a sending domain",
  description:
    "Adds the domain that emails come from, lists the DNS records to add, and runs the first check.",
  method: "post",
  path: "/domains",
  scope: "workspace:admin",
  risk: "write",
  mcp: ADMIN_ONLY,
  successStatus: 201,
  input: z.object({
    domain: z.string().max(253),
    trackingDomain: z.string().max(253).optional(),
    dkimSelectors: selectorsInput.optional(),
  }),
  output: SendingDomainSchema,
  async handler(input, ctx) {
    const { principal, db } = ctx;
    const domain = normalizeDomain(input.domain, "The domain");
    const tracking = input.trackingDomain
      ? normalizeDomain(input.trackingDomain, "The tracking domain")
      : null;
    const exists = await db.db
      .selectFrom("sending_domains")
      .select("id")
      .where("workspace_id", "=", principal.workspaceId)
      .where("domain", "=", domain)
      .executeTakeFirst();
    if (exists)
      throw new OperationError(
        "conflict",
        `${domain} is already a sending domain of this workspace.`,
      );
    const connection = await sendingConnection(db, principal.workspaceId);
    const row = await db.db
      .insertInto("sending_domains")
      .values({
        workspace_id: principal.workspaceId,
        connection_id: connection?.id ?? null,
        domain,
        tracking_domain: tracking,
        last_checked_at: null,
        verified_at: null,
        dkim_selectors: JSON.stringify(input.dkimSelectors ?? []),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDomain(await recheck(ctx, row));
  },
  auditTarget: (_input, output) => ({
    targetType: "sending_domain",
    targetId: output.id,
    metadata: { domain: output.domain },
  }),
});

export const domainsUpdate = defineOperation({
  id: "domains.update",
  summary: "Change a sending domain",
  description: "Sets the tracking domain or the DKIM selectors, then checks the domain again.",
  method: "patch",
  path: "/domains/{id}",
  scope: "workspace:admin",
  risk: "write",
  mcp: ADMIN_ONLY,
  input: idInput.extend({
    trackingDomain: z.string().max(253).nullable().optional(),
    dkimSelectors: selectorsInput.optional(),
  }),
  output: SendingDomainSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    await loadDomain(db, principal.workspaceId, input.id);
    const values: { tracking_domain?: string | null; dkim_selectors?: string; updated_at: number } =
      { updated_at: now };
    if (input.trackingDomain !== undefined) {
      values.tracking_domain = input.trackingDomain
        ? normalizeDomain(input.trackingDomain, "The tracking domain")
        : null;
    }
    if (input.dkimSelectors !== undefined)
      values.dkim_selectors = JSON.stringify(input.dkimSelectors);
    const row = await db.db
      .updateTable("sending_domains")
      .set(values)
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDomain(await recheck(ctx, row));
  },
  auditTarget: (_input, output) => ({ targetType: "sending_domain", targetId: output.id }),
});

export const domainsCheck = defineOperation({
  id: "domains.check",
  summary: "Check the DNS records of a domain",
  description:
    "Looks up SPF, DKIM, DMARC, and the tracking domain over DNS over HTTPS and saves the result.",
  method: "post",
  path: "/domains/{id}/check",
  scope: "workspace:admin",
  risk: "write",
  mcp: {
    class: "later",
    reason: "Agents read the status. A check that writes it stays in the admin app for now.",
  },
  input: idInput,
  output: SendingDomainSchema,
  async handler(input, ctx) {
    return toDomain(
      await recheck(ctx, await loadDomain(ctx.db, ctx.principal.workspaceId, input.id)),
    );
  },
  auditTarget: (_input, output) => ({
    targetType: "sending_domain",
    targetId: output.id,
    metadata: { status: output.status },
  }),
});

export const domainsDelete = defineOperation({
  id: "domains.delete",
  summary: "Remove a sending domain",
  description: "Removes the domain from Envelopen. The DNS records and the provider's domain stay.",
  method: "delete",
  path: "/domains/{id}",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: ADMIN_ONLY,
  input: idInput,
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    await loadDomain(db, principal.workspaceId, input.id);
    await db.db
      .deleteFrom("sending_domains")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "sending_domain", targetId: output.id }),
});
