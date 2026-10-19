import type { DbConnection } from "@envelopen/db";
import { z } from "zod";
import { defineOperation } from "../operation";

// The onboarding checklist on the Overview page (U5). Each step is derived from the
// tables that later units fill, so the checklist needs no state of its own. Every
// query asks for one row at most, so a large workspace costs no more than an empty one.

export const ONBOARDING_STEP_IDS = [
  "connect_provider",
  "verify_domain",
  "import_contacts",
  "send_test",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/**
 * - `done`: the condition holds.
 * - `todo`: the owner can do the step now.
 * - `waiting`: the owner did their part, and an outside party must finish, for example DNS.
 * - `blocked`: an error, or an earlier step, stops the step.
 */
export const ONBOARDING_STATUSES = ["done", "todo", "waiting", "blocked"] as const;

export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/**
 * The audit action of a test send. The campaign engine (U9) records it when the owner
 * sends a test email, and the checklist reads it.
 */
export const TEST_SEND_ACTION = "campaigns.send_test";

/** Guides for each step, relative to the repository root. */
export const ONBOARDING_GUIDES: Readonly<Record<OnboardingStepId, string>> = {
  connect_provider: "docs/guides/README.md#email-providers",
  verify_domain: "docs/guides/sending-domain.md",
  import_contacts: "docs/guides/import-contacts.md",
  send_test: "docs/guides/test-send.md",
};

const TITLES: Readonly<Record<OnboardingStepId, string>> = {
  connect_provider: "Connect a provider",
  verify_domain: "Verify a sending domain",
  import_contacts: "Import contacts",
  send_test: "Send a test",
};

export const OnboardingStepSchema = z
  .object({
    id: z.enum(ONBOARDING_STEP_IDS),
    title: z.string(),
    status: z.enum(ONBOARDING_STATUSES),
    detail: z.string().meta({ description: "One sentence about the current state." }),
    guide: z.string().meta({ description: "Path of the guide, relative to the repository." }),
  })
  .meta({ id: "OnboardingStep" });

export const OnboardingStatusSchema = z
  .object({
    steps: z.array(OnboardingStepSchema),
    completed: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: "OnboardingStatus" });

type Step = z.input<typeof OnboardingStepSchema>;

function step(id: OnboardingStepId, status: OnboardingStatus, detail: string): Step {
  return { id, title: TITLES[id], status, detail, guide: ONBOARDING_GUIDES[id] };
}

async function connectionStep(db: DbConnection, workspaceId: number): Promise<Step> {
  // An active connection wins over an older one with an error.
  const row = await db.db
    .selectFrom("provider_connections")
    .select(["name", "status", "status_detail"])
    .where("workspace_id", "=", workspaceId)
    .where("status", "!=", "disabled")
    .orderBy((eb) => eb.case().when("status", "=", "active").then(0).else(1).end())
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return step("connect_provider", "todo", "Paste a provider API key to connect it.");
  }
  if (row.status === "active") {
    return step("connect_provider", "done", `${row.name} is connected.`);
  }
  return step(
    "connect_provider",
    "blocked",
    row.status_detail ?? `${row.name} reports an error. Check the connection.`,
  );
}

const DNS_RECORDS = [
  ["spf_status", "SPF"],
  ["dkim_status", "DKIM"],
  ["dmarc_status", "DMARC"],
] as const;

async function domainStep(
  db: DbConnection,
  workspaceId: number,
  connected: boolean,
): Promise<Step> {
  // A verified domain wins. Otherwise the oldest domain tells what is left.
  const row = await db.db
    .selectFrom("sending_domains")
    .select(["domain", "spf_status", "dkim_status", "dmarc_status", "verified_at"])
    .where("workspace_id", "=", workspaceId)
    .orderBy((eb) => eb.case().when("verified_at", "is not", null).then(0).else(1).end())
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();
  if (row?.verified_at != null) {
    return step("verify_domain", "done", `${row.domain} is verified.`);
  }
  if (!connected) {
    return step("verify_domain", "blocked", "Connect a provider first.");
  }
  if (!row) {
    return step("verify_domain", "todo", "Add the domain that your emails come from.");
  }
  const failed = DNS_RECORDS.filter(([column]) => row[column] === "fail").map(([, label]) => label);
  if (failed.length > 0) {
    return step(
      "verify_domain",
      "blocked",
      `${failed.join(", ")} for ${row.domain} failed. Fix the DNS record, then check again.`,
    );
  }
  return step("verify_domain", "waiting", `Waiting for the DNS records of ${row.domain}.`);
}

async function contactsStep(db: DbConnection, workspaceId: number): Promise<Step> {
  const row = await db.db
    .selectFrom("contacts")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst();
  return row
    ? step("import_contacts", "done", "This workspace has contacts.")
    : step("import_contacts", "todo", "Upload a CSV, map the columns, and set the consent basis.");
}

async function testSendStep(db: DbConnection, workspaceId: number, ready: boolean): Promise<Step> {
  const tested = await db.db
    .selectFrom("audit_log")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("action", "=", TEST_SEND_ACTION)
    .limit(1)
    .executeTakeFirst();
  // A sent campaign also proves that sending works.
  const sent =
    tested ??
    (await db.db
      .selectFrom("campaign_recipients")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("status", "=", "sent")
      .limit(1)
      .executeTakeFirst());
  if (sent) return step("send_test", "done", "A test email was sent.");
  if (!ready) {
    return step("send_test", "blocked", "Connect a provider and verify a domain first.");
  }
  return step("send_test", "todo", "Send a test email to yourself before the first campaign.");
}

export const onboardingStatus = defineOperation({
  id: "onboarding.status",
  summary: "Get the onboarding checklist",
  description:
    "Returns the four setup steps of the workspace (connect a provider, verify a domain, " +
    "import contacts, send a test) with the state of each and a guide.",
  method: "get",
  path: "/onboarding",
  scope: "stats:read",
  risk: "read",
  mcp: {
    class: "now",
    reason:
      "Read-only status, like the provider and domain status that agents may read. " +
      "It shows no credentials and changes nothing.",
  },
  input: z.object({}),
  output: OnboardingStatusSchema,
  async handler(_input, { principal, db }) {
    const workspaceId = principal.workspaceId;
    const [connection, contacts] = await Promise.all([
      connectionStep(db, workspaceId),
      contactsStep(db, workspaceId),
    ]);
    const domain = await domainStep(db, workspaceId, connection.status === "done");
    const test = await testSendStep(
      db,
      workspaceId,
      connection.status === "done" && domain.status === "done",
    );
    const steps = [connection, domain, contacts, test];
    return {
      steps,
      completed: steps.filter((item) => item.status === "done").length,
      total: steps.length,
    };
  },
});
