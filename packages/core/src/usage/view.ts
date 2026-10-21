import { nextUtcMidnight } from "@envelopen/db";
import { z } from "zod";
import type { UsageStatus } from "../services";
import {
  PLAN_LIMITS,
  reservedThreshold,
  WELCOME_RESERVE_RATIO,
  WORKERS_PLANS,
  type WorkersPlan,
} from "./limits";

// The usage view (R4, R71, KTD24). It reads the UsageMeter Durable Object, which counts
// the D1 rows that the metered binding wrote today. The view shows the rows used and
// left, the reset time (00:00 UTC), a warning at 80%, and a Workers Paid hint near the
// limit. D1 rows written is the only limit that Envelopen measures in v1. The other
// limits are listed with their values and `measured: false`.
//
// The owner's Workers plan setting (U11) shapes the view. On Free, it shows the reserved
// threshold (70%), where welcome steps start to wait, and the share of today's writes
// that welcome steps made. On Paid, D1 has no daily write limit, so the view gives no
// warning and no threshold.

/** The usage view warns from this share of the daily D1 writes. */
export const USAGE_WARNING_RATIO = 0.8;

export const USAGE_STATES = ["ok", "warning", "limit"] as const;
export type UsageState = (typeof USAGE_STATES)[number];

export const PAID_HINT =
  "Workers Paid has no daily D1 write limit. Upgrade the account in the Cloudflare " +
  "dashboard to send regular campaigns without pauses.";

export const UsageSchema = z
  .object({
    day: z.string().meta({ description: "The UTC day of the counts, YYYY-MM-DD." }),
    resetsAt: z.number().int().meta({ description: "The next 00:00 UTC, Unix milliseconds." }),
    d1Writes: z.object({
      used: z.number().int(),
      limit: z.number().int(),
      remaining: z.number().int(),
      ratio: z.number().meta({ description: "Share of the daily limit used, 0 to 1 or more." }),
      automation: z.number().int().meta({
        description: "The part of `used` that welcome steps wrote today.",
      }),
      reserved: z
        .number()
        .int()
        .nullable()
        .meta({
          description:
            "The rows after which welcome steps wait until the reset (70% of the limit), so " +
            "campaigns and unsubscribes keep the rest. Null on Workers Paid.",
        }),
      state: z.enum(USAGE_STATES).meta({
        description:
          "`warning` from 80% of the limit. `limit` when D1 rejected writes and sending is " +
          "paused until the reset.",
      }),
    }),
    workersPlan: z.enum(WORKERS_PLANS).meta({
      description: "The Workers plan that the owner set in Settings.",
    }),
    reserveRatio: z.number().meta({
      description: "The share of the daily D1 writes that welcome steps can use on Free.",
    }),
    warning: z.boolean().meta({ description: "True from 80% of the daily D1 writes." }),
    paidHint: z
      .string()
      .nullable()
      .meta({ description: "Advice to move to Workers Paid, near the limit. Null otherwise." }),
    platformLimit: z
      .object({ since: z.number().int(), until: z.number().int() })
      .nullable()
      .meta({ description: "D1 rejected writes since `since`. Sending resumes after `until`." }),
    limits: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        free: z.string(),
        paid: z.string(),
        measured: z.boolean().meta({ description: "Envelopen counts this limit." }),
        used: z.number().int().nullable(),
      }),
    ),
  })
  .meta({ id: "Usage" });

export type UsageView = z.input<typeof UsageSchema>;

export function usageView(
  status: UsageStatus,
  now: number,
  workersPlan: WorkersPlan = "free",
): UsageView {
  const used = Math.max(0, Math.trunc(status.rowsWritten));
  const automation = Math.min(used, Math.max(0, Math.trunc(status.automationRows ?? 0)));
  const limit = status.dailyLimit;
  const ratio = limit > 0 ? used / limit : 0;
  const platformLimit =
    status.platformLimit && status.platformLimit.until > now ? status.platformLimit : null;
  const paid = workersPlan === "paid";
  // On Paid, D1 has no daily write limit: only a rejected write is a limit.
  const state: UsageState =
    platformLimit || (!paid && used >= limit)
      ? "limit"
      : !paid && ratio >= USAGE_WARNING_RATIO
        ? "warning"
        : "ok";
  return {
    day: status.day,
    resetsAt: nextUtcMidnight(now),
    d1Writes: {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      ratio,
      state,
      automation,
      reserved: paid ? null : reservedThreshold(limit),
    },
    workersPlan,
    reserveRatio: WELCOME_RESERVE_RATIO,
    warning: state !== "ok",
    paidHint: state === "ok" || paid ? null : PAID_HINT,
    platformLimit,
    limits: PLAN_LIMITS.map((item) => ({
      ...item,
      measured: item.id === "d1_writes",
      used: item.id === "d1_writes" ? used : null,
    })),
  };
}
