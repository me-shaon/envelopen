import type { BrandLogoContentType, DbConnection, Row } from "@envelopen/db";
import {
  BRAND_FONT_IDS,
  BRAND_FONTS,
  type BrandSnapshot,
  DEFAULT_BRAND,
  parseBrandSnapshot,
} from "@envelopen/email-render";
import { SOCIAL_NETWORKS, type SocialNetwork } from "@envelopen/email-render/blocks/types";
import { z } from "zod";

// The brand kit (U13, R18, R19, KTD10). One row per workspace in `brand_kits`. Templates
// use it through `{{ brand.* }}` tokens. Drafts, previews, and welcome emails fill them
// from the live kit (`liveBrand`). A campaign stores the values at confirm in
// `campaigns.brand_snapshot`, and its batches fill the tokens from that snapshot.
//
// Logos: PNG, JPEG, GIF, or WebP, at most 1 MB, checked by their magic bytes (logo.ts).
// The R2 key is content-addressed, `brand/<workspace id>/<sha-256>.<ext>`, and the public
// route `/b/<workspace id>/<sha-256>.<ext>` serves it (apps/worker/src/brand/route.ts).
// Every upload becomes the kit logo at once. A replaced or removed logo is never
// deleted, because sent emails (welcome emails too) and confirmed campaigns load it.
// Logos are small and change rarely.

export const LOGO_MAX_BYTES = 1024 * 1024;

export const LOGO_TYPES: Readonly<Record<BrandLogoContentType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The path segment after `/b/`: `<workspace id>/<sha-256 hex>.<ext>`. */
const LOGO_FILE = /^(\d+)\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/;

export function logoKey(workspaceId: number, sha256: string, contentType: BrandLogoContentType) {
  return `brand/${workspaceId}/${sha256}.${LOGO_TYPES[contentType]}`;
}

/** The public URL of a logo key: `<origin>/b/<workspace id>/<file>`. */
export function logoUrl(origin: string | undefined, key: string): string {
  return `${(origin ?? "").replace(/\/+$/, "")}/b/${key.slice("brand/".length)}`;
}

/** The workspace and the R2 key of a public logo path, or null when it is not one. */
export function parseLogoPath(path: string): { workspaceId: number; key: string } | null {
  const match = LOGO_FILE.exec(path);
  if (!match) return null;
  const workspaceId = Number(match[1]);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) return null;
  return { workspaceId, key: `brand/${path}` };
}

const SocialSchema = z
  .object(
    Object.fromEntries(SOCIAL_NETWORKS.map((network) => [network, z.string().optional()])) as {
      [K in SocialNetwork]: z.ZodOptional<z.ZodString>;
    },
  )
  .meta({ id: "BrandSocialLinks", description: "https URL by social network." });

export const BrandSchema = z
  .object({
    name: z.string().meta({ description: "Defaults to the workspace name when empty." }),
    logo: z
      .object({
        url: z.string(),
        contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        size: z.number().int(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
      })
      .nullable(),
    colorPrimary: z.string().meta({ description: "`#rrggbb`." }),
    colorAccent: z.string().meta({ description: "`#rrggbb`." }),
    font: z.enum(BRAND_FONT_IDS as [string, ...string[]]),
    footer: z.string(),
    address: z
      .string()
      .meta({ description: "The postal address. A campaign cannot be confirmed without it." }),
    social: SocialSchema,
    fonts: z
      .array(z.object({ id: z.string(), label: z.string(), stack: z.string() }))
      .meta({ description: "The web-safe fonts that `font` can name." }),
    tokens: z.object({ name: z.string() }).meta({
      description: "The values that fill the tokens now: the brand name after defaults.",
    }),
    updatedAt: z.number().int().nullable(),
  })
  .meta({ id: "Brand" });

export type Brand = z.output<typeof BrandSchema>;

export interface BrandRow {
  workspaceName: string;
  kit: Row<"brand_kits"> | undefined;
}

/** The brand kit row, and the workspace name when the kit has no name of its own. */
export async function loadBrand(db: DbConnection, workspaceId: number): Promise<BrandRow> {
  const kit = await db.db
    .selectFrom("brand_kits")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (kit?.name) return { workspaceName: "", kit };
  const workspace = await db.db
    .selectFrom("workspaces")
    .select("name")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return { workspaceName: workspace?.name ?? "", kit };
}

export function parseSocial(
  value: string | null | undefined,
): Partial<Record<SocialNetwork, string>> {
  if (!value) return {};
  try {
    return parseBrandSnapshot({ social: JSON.parse(value) }).social;
  } catch {
    return {};
  }
}

/** The brand values that fill the tokens. `origin` makes the logo URL absolute. */
export function snapshotOf(brand: BrandRow, origin: string | undefined): BrandSnapshot {
  const { kit } = brand;
  if (!kit) return { ...DEFAULT_BRAND, name: brand.workspaceName };
  return parseBrandSnapshot({
    name: kit.name || brand.workspaceName,
    logoUrl: kit.logo_key ? logoUrl(origin, kit.logo_key) : null,
    logoKey: kit.logo_key,
    colorPrimary: kit.color_primary,
    colorAccent: kit.color_accent,
    font: kit.font,
    footer: kit.footer_text,
    address: kit.postal_address,
    social: parseSocial(kit.social_links),
  });
}

/** The live brand of a workspace, for drafts, previews, test sends, and welcome emails. */
export async function liveBrand(
  db: DbConnection,
  workspaceId: number,
  origin: string | undefined,
): Promise<BrandSnapshot> {
  return snapshotOf(await loadBrand(db, workspaceId), origin);
}

/** The brand of a campaign: its snapshot after confirm, else the live brand. */
export async function campaignBrand(
  db: DbConnection,
  campaign: Pick<Row<"campaigns">, "workspace_id" | "brand_snapshot">,
  origin: string | undefined,
): Promise<BrandSnapshot> {
  if (campaign.brand_snapshot) return parseBrandSnapshot(campaign.brand_snapshot);
  return liveBrand(db, campaign.workspace_id, origin);
}

export function toBrand(brand: BrandRow, appOrigin: string | undefined): Brand {
  const snapshot = snapshotOf(brand, appOrigin);
  const kit = brand.kit;
  return {
    name: kit?.name ?? "",
    logo:
      kit?.logo_key && kit.logo_content_type
        ? {
            url: logoUrl(appOrigin, kit.logo_key),
            contentType: kit.logo_content_type,
            size: kit.logo_size ?? 0,
            width: kit.logo_width,
            height: kit.logo_height,
          }
        : null,
    colorPrimary: snapshot.colorPrimary,
    colorAccent: snapshot.colorAccent,
    font: snapshot.font,
    footer: snapshot.footer,
    address: snapshot.address,
    social: snapshot.social,
    fonts: BRAND_FONT_IDS.map((id) => ({ id, ...BRAND_FONTS[id] })),
    tokens: { name: snapshot.name },
    updatedAt: kit?.updated_at ?? null,
  };
}
