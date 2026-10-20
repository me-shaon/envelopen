import type { CampaignType, DbConnection } from "@envelopen/db";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, testDb } from "../../test/fixtures";
import {
  type AudienceEstimate,
  estimateAudience,
  excluded,
  exclusionCountsOf,
  exclusionReason,
  insertPageRecipientsQuery,
  pageExclusionsQuery,
  suppressionJoin,
  targeted,
} from "./audience";
import { type CampaignAudience, EXCLUSION_REASONS, emptyExclusions } from "./model";

// The estimate and the snapshot read the targeted memberships (migration 0014). These
// tests compare them with the earlier form, which applies the same SQL rules to every
// contact of the workspace, on random fixtures and audiences.

/** A small seeded random generator (mulberry32), so a failure repeats. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  conn: DbConnection;
  workspaceId: number;
  lists: number[];
  tags: number[];
  parents: number[];
  maxId: number;
  minId: number;
}

const CONTACTS = 240;

async function fixture(seed: number): Promise<Fixture> {
  const next = random(seed);
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, `Audience ${seed}`);
  // A second workspace with memberships too, so the scope of every subquery counts.
  const other = await createOwnedWorkspace(conn, userId, `Other ${seed}`);
  const lists: number[] = [];
  const tags: number[] = [];
  for (let i = 0; i < 5; i++) {
    const list = await conn.db
      .insertInto("lists")
      .values({ workspace_id: workspaceId, name: `L${i}`, description: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    lists.push(list.id);
    const tag = await conn.db
      .insertInto("tags")
      .values({ workspace_id: workspaceId, name: `t${i}` })
      .returning("id")
      .executeTakeFirstOrThrow();
    tags.push(tag.id);
  }
  const contacts: number[] = [];
  for (let i = 0; i < CONTACTS; i++) {
    const workspace = next() < 0.15 ? other : workspaceId;
    const basis = next() < 0.2 ? "unknown" : next() < 0.5 ? "existing_customer" : "explicit_opt_in";
    const row = await conn.db
      .insertInto("contacts")
      .values({
        workspace_id: workspace,
        email: `c${i}-${seed}@audience.test`,
        email_hash: `h${i}-${seed}`,
        consent_basis: basis,
        consent_source: "test",
        consent_at: 0,
        source: "test",
        unsubscribed_at: next() < 0.1 ? 1 : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (workspace !== workspaceId) {
      // Memberships of another workspace in this workspace's lists and tags: the old
      // and the new form must both ignore them.
      if (next() < 0.5) {
        await sql`INSERT INTO list_members (workspace_id, list_id, contact_id, status, status_source, status_at)
VALUES (${other}, ${lists[0]}, ${row.id}, 'subscribed', 'test', 0)`.execute(conn.db);
      }
      continue;
    }
    contacts.push(row.id);
    for (const list of lists) {
      if (next() < 0.35) {
        await sql`INSERT INTO list_members (workspace_id, list_id, contact_id, status, status_source, status_at)
VALUES (${workspaceId}, ${list}, ${row.id}, ${next() < 0.25 ? "unsubscribed" : "subscribed"}, 'test', 0)`.execute(
          conn.db,
        );
      }
    }
    for (const tag of tags) {
      if (next() < 0.25) {
        await sql`INSERT INTO contact_tags (workspace_id, contact_id, tag_id) VALUES (${workspaceId}, ${row.id}, ${tag})`.execute(
          conn.db,
        );
      }
    }
    if (next() < 0.1) {
      await conn.db
        .insertInto("suppressions")
        .values({
          workspace_id: workspaceId,
          email_hash: `h${i}-${seed}`,
          reason: "manual",
          source: "test",
          campaign_id: null,
        })
        .execute();
    }
  }
  // Two sent parent campaigns for follow-ups, with some human opens.
  const parents: number[] = [];
  for (let p = 0; p < 2; p++) {
    const parent = await conn.db
      .insertInto("campaigns")
      .values({ workspace_id: workspaceId, name: `Parent ${p}`, status: "sent" })
      .returning("id")
      .executeTakeFirstOrThrow();
    parents.push(parent.id);
    for (const contact of contacts) {
      if (next() < 0.6) {
        await sql`INSERT INTO campaign_recipients (workspace_id, campaign_id, contact_id, status, opened_at)
VALUES (${workspaceId}, ${parent.id}, ${contact}, ${next() < 0.9 ? "sent" : "failed"}, ${next() < 0.4 ? 5 : null})`.execute(
          conn.db,
        );
      }
    }
  }
  return {
    conn,
    workspaceId,
    lists,
    tags,
    parents,
    minId: Math.min(...contacts),
    maxId: Math.max(...contacts),
  };
}

function pickSome(next: () => number, ids: readonly number[], chance: number): number[] {
  return ids.filter(() => next() < chance);
}

function randomAudience(next: () => number, f: Fixture): CampaignAudience {
  for (;;) {
    const audience: CampaignAudience = {
      listIds: pickSome(next, f.lists, 0.3),
      tagIds: pickSome(next, f.tags, 0.2),
      excludeListIds: pickSome(next, f.lists, 0.15),
      excludeTagIds: pickSome(next, f.tags, 0.15),
      followUpOf: next() < 0.25 ? (f.parents[next() < 0.5 ? 0 : 1] ?? null) : null,
    };
    if (audience.listIds.length + audience.tagIds.length > 0) return audience;
  }
}

/** The earlier estimate: the rules over every contact of the workspace. */
async function referenceEstimate(
  f: Fixture,
  audience: CampaignAudience,
  type: CampaignType,
  range?: { afterId: number; toId: number },
): Promise<AudienceEstimate> {
  const inRange = range ? sql` AND c.id > ${range.afterId} AND c.id <= ${range.toId}` : sql``;
  const { rows } = await sql<{ reason: string | null; n: number }>`
SELECT reason, count(*) AS n FROM (
  SELECT ${exclusionReason(f.workspaceId, audience, type)} AS reason
  FROM contacts c ${suppressionJoin(f.workspaceId)}
  WHERE c.workspace_id = ${f.workspaceId}${inRange} AND ${targeted(f.workspaceId, audience)} AND NOT ${excluded(f.workspaceId, audience)}
) GROUP BY reason`.execute(f.conn.db);
  const estimate: AudienceEstimate = { recipients: 0, excluded: emptyExclusions() };
  for (const row of rows) {
    if (row.reason === null) estimate.recipients += Number(row.n);
    else if ((EXCLUSION_REASONS as readonly string[]).includes(row.reason)) {
      estimate.excluded[row.reason as keyof AudienceEstimate["excluded"]] += Number(row.n);
    }
  }
  return estimate;
}

/** The earlier snapshot insert: the recipients of a page, in contact id order. */
async function referenceRecipients(
  f: Fixture,
  audience: CampaignAudience,
  type: CampaignType,
  range: { afterId: number; toId: number },
): Promise<number[]> {
  const { rows } = await sql<{ id: number }>`
SELECT c.id FROM contacts c ${suppressionJoin(f.workspaceId)}
WHERE c.workspace_id = ${f.workspaceId} AND c.id > ${range.afterId} AND c.id <= ${range.toId}
  AND ${targeted(f.workspaceId, audience)} AND NOT ${excluded(f.workspaceId, audience)}
  AND (${exclusionReason(f.workspaceId, audience, type)}) IS NULL
ORDER BY c.id`.execute(f.conn.db);
  return rows.map((row) => row.id);
}

describe("audience from memberships", () => {
  const fixtures: Fixture[] = [];
  beforeAll(async () => {
    for (const seed of [11, 22, 33]) fixtures.push(await fixture(seed));
  });

  it("estimates the same counts as the rules over every contact", async () => {
    let compared = 0;
    for (const [index, f] of fixtures.entries()) {
      const next = random(1000 + index);
      for (let i = 0; i < 25; i++) {
        const audience = randomAudience(next, f);
        for (const type of ["regular", "re-permission"] as const) {
          const expected = await referenceEstimate(f, audience, type);
          const actual = await estimateAudience(f.conn, f.workspaceId, audience, type);
          expect({ audience, type, actual }).toEqual({ audience, type, actual: expected });
          compared++;
        }
      }
    }
    expect(compared).toBe(150);
  });

  it("takes the same recipients and exclusions per snapshot page, in contact id order", async () => {
    for (const [index, f] of fixtures.entries()) {
      const next = random(2000 + index);
      for (let i = 0; i < 10; i++) {
        const audience = randomAudience(next, f);
        const type: CampaignType = next() < 0.5 ? "regular" : "re-permission";
        const campaign = await f.conn.db
          .insertInto("campaigns")
          .values({ workspace_id: f.workspaceId, name: `Snapshot ${i}`, status: "sending" })
          .returning("id")
          .executeTakeFirstOrThrow();
        // Pages of 37 contact ids, starting before the first contact.
        for (let afterId = f.minId - 5; afterId < f.maxId; afterId += 37) {
          const range = { afterId, toId: afterId + 37 };
          const expected = await referenceRecipients(f, audience, type, range);
          const results = await f.conn.atomic([
            pageExclusionsQuery(
              f.conn.db,
              f.workspaceId,
              audience,
              type,
              range.afterId,
              range.toId,
            ),
            insertPageRecipientsQuery(
              f.conn.db,
              f.workspaceId,
              campaign.id,
              audience,
              type,
              range.afterId,
              range.toId,
            ),
          ]);
          const reference = await referenceEstimate(f, audience, type, range);
          expect(exclusionCountsOf((results[0]?.results ?? []) as never[])).toEqual(
            reference.excluded,
          );
          const inserted = await f.conn.db
            .selectFrom("campaign_recipients")
            .select(["id", "contact_id"])
            .where("workspace_id", "=", f.workspaceId)
            .where("campaign_id", "=", campaign.id)
            .where("contact_id", ">", range.afterId)
            .where("contact_id", "<=", range.toId)
            .orderBy("id")
            .execute();
          // Recipient ids follow contact ids, so the batches group contacts as before.
          expect({ audience, range, ids: inserted.map((row) => row.contact_id) }).toEqual({
            audience,
            range,
            ids: expected,
          });
        }
      }
    }
  });
});
