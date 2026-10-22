import {
  BRAND_ADDRESS_MAX,
  BRAND_FONT_IDS,
  BRAND_FOOTER_MAX,
  BRAND_NAME_MAX,
  brandUrl,
  normalizeHexColor,
} from "@envelopen/email-render";
import { SOCIAL_NETWORKS, type SocialNetwork } from "@envelopen/email-render/blocks/types";
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { checkLogo } from "./logo";
import { BrandSchema, LOGO_MAX_BYTES, loadBrand, logoKey, toBrand } from "./model";

// The brand kit operations (U13). Reading the brand needs campaigns:read, so an agent can
// see the values that fill the tokens. Changes stay with the owner's session: the brand
// and the postal address speak for the sender (plan: brand uses session-only scopes).

const BRAND_WRITE_MCP = {
  class: "later",
  reason:
    "The brand kit and the postal address speak for the sender in every email. Only the " +
    "owner session changes them for now. An API scope can come later.",
} as const;

/** Base64 of at most LOGO_MAX_BYTES bytes. */
const LOGO_BASE64_MAX = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(max: number, label: string, multiline: boolean) {
  return z
    .string()
    .max(max)
    .transform((value) => value.replaceAll("\r\n", "\n").trim())
    .refine((value) => !CONTROL.test(value) && (multiline || !value.includes("\n")), {
      message: `${label} has characters that an email cannot show.`,
    });
}

const BrandInput = z.object({
  name: text(BRAND_NAME_MAX, "The name", false).meta({
    description: "The brand name. Empty uses the workspace name.",
  }),
  colorPrimary: z.string().max(20).meta({ description: "`#rrggbb` or `#rgb`." }),
  colorAccent: z.string().max(20).meta({ description: "`#rrggbb` or `#rgb`." }),
  font: z.enum(BRAND_FONT_IDS as [string, ...string[]]),
  footer: text(BRAND_FOOTER_MAX, "The footer text", true),
  address: text(BRAND_ADDRESS_MAX, "The postal address", true).meta({
    description: "The sender's postal address. A campaign cannot be confirmed without it.",
  }),
  social: z
    .record(z.string(), z.string().max(600))
    .default({})
    .meta({ description: "An https URL by network. An empty value removes the link." }),
});

type CleanBrand = {
  name: string;
  color_primary: string;
  color_accent: string;
  font: string;
  footer_text: string;
  postal_address: string;
  social_links: string;
};

function cleanBrand(input: z.output<typeof BrandInput>): CleanBrand {
  const primary = normalizeHexColor(input.colorPrimary);
  if (!primary) {
    throw new OperationError(
      "invalid_input",
      "The primary color must be a hex color, for example #4a3c77.",
      {
        field: "colorPrimary",
      },
    );
  }
  const accent = normalizeHexColor(input.colorAccent);
  if (!accent) {
    throw new OperationError(
      "invalid_input",
      "The accent color must be a hex color, for example #ede9f8.",
      {
        field: "colorAccent",
      },
    );
  }
  const social: Partial<Record<SocialNetwork, string>> = {};
  for (const [network, value] of Object.entries(input.social)) {
    if (!(SOCIAL_NETWORKS as readonly string[]).includes(network)) {
      throw new OperationError(
        "invalid_input",
        `Envelopen does not know the network "${network}".`,
        {
          field: "social",
        },
      );
    }
    if (value.trim() === "") continue;
    const url = brandUrl(value, ["https:"]);
    if (!url) {
      throw new OperationError(
        "invalid_input",
        "Each social link must be a full https URL, for example https://x.com/yourname.",
        { field: `social.${network}` },
      );
    }
    social[network as SocialNetwork] = url;
  }
  return {
    name: input.name,
    color_primary: primary,
    color_accent: accent,
    font: input.font,
    footer_text: input.footer,
    postal_address: input.address,
    social_links: JSON.stringify(social),
  };
}

async function respond(ctx: OperationContext) {
  return toBrand(await loadBrand(ctx.db, ctx.principal.workspaceId), ctx.services.appOrigin);
}

async function setLogo(
  ctx: OperationContext,
  logo: {
    key: string;
    contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    size: number;
    width: number | null;
    height: number | null;
  } | null,
) {
  const values = {
    logo_key: logo?.key ?? null,
    logo_content_type: logo?.contentType ?? null,
    logo_size: logo?.size ?? null,
    logo_width: logo?.width ?? null,
    logo_height: logo?.height ?? null,
    updated_at: ctx.now,
  };
  await ctx.db.db
    .insertInto("brand_kits")
    .values({ workspace_id: ctx.principal.workspaceId, ...values, created_at: ctx.now })
    .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet(values))
    .execute();
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) {
    throw new OperationError("invalid_input", "The file content must be base64.", {
      field: "content",
    });
  }
  const binary = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const brandGet = defineOperation({
  id: "brand.get",
  summary: "Get the brand kit",
  description:
    "Returns the brand kit of the workspace: name, logo, colors, font, footer text, postal " +
    "address, and social links. Templates use them through `{{ brand.* }}` tokens. Drafts " +
    "show the live brand, and a confirmed campaign keeps the brand of its confirm time.",
  method: "get",
  path: "/brand",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "A read. An agent can see the values that fill the tokens." },
  input: z.object({}),
  output: BrandSchema,
  async handler(_input, ctx) {
    return respond(ctx);
  },
});

export const brandUpdate = defineOperation({
  id: "brand.update",
  summary: "Change the brand kit",
  description:
    "Replaces the brand values except the logo. Colors must be hex colors, the font one of " +
    "the web-safe fonts, and each social link an https URL. Drafts use the new values at " +
    "once. Confirmed campaigns keep their snapshot.",
  method: "put",
  path: "/brand",
  scope: "workspace:admin",
  risk: "write",
  mcp: BRAND_WRITE_MCP,
  input: BrandInput,
  output: BrandSchema,
  async handler(input, ctx) {
    const values = cleanBrand(input);
    await ctx.db.db
      .insertInto("brand_kits")
      .values({
        workspace_id: ctx.principal.workspaceId,
        ...values,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((conflict) =>
        conflict.column("workspace_id").doUpdateSet({ ...values, updated_at: ctx.now }),
      )
      .execute();
    return respond(ctx);
  },
  auditTarget: () => ({ targetType: "brand" }),
});

export const brandUploadLogo = defineOperation({
  id: "brand.upload_logo",
  summary: "Upload the brand logo",
  description:
    "Sets the brand logo. The file must be a PNG, JPEG, GIF, or WebP image of at most 1 MB. " +
    "The type comes from the file's bytes, and SVG is refused. The logo is served at a " +
    "fixed public URL. A replaced logo stays, so sent emails keep their logo.",
  method: "post",
  path: "/brand/logo",
  scope: "workspace:admin",
  risk: "write",
  mcp: BRAND_WRITE_MCP,
  input: z.object({
    filename: z.string().trim().max(200).optional(),
    contentType: z.string().trim().max(100).optional(),
    content: z
      .string()
      .max(LOGO_BASE64_MAX + 100)
      .meta({ description: "The image bytes, base64. At most 1 MB before encoding." }),
  }),
  output: BrandSchema,
  async handler(input, ctx) {
    const bucket = requireService(ctx.services, "bucket");
    const workspaceId = ctx.principal.workspaceId;
    const bytes = decodeBase64(input.content);
    const check = checkLogo(bytes, input, LOGO_MAX_BYTES);
    if (!check.ok) {
      throw new OperationError("invalid_input", check.message, { field: check.field });
    }
    const { contentType, width, height } = check.image;
    const key = logoKey(workspaceId, await sha256Hex(bytes), contentType);
    // The same bytes give the same key, so an upload of a known logo writes nothing new.
    await bucket.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    });
    await ctx.db.db
      .insertInto("brand_logos")
      .values({
        workspace_id: workspaceId,
        key,
        content_type: contentType,
        size: bytes.length,
        width,
        height,
        bytes,
        created_at: ctx.now,
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "key"]).doNothing())
      .execute();
    // An upload becomes the kit logo at once, so no upload is left unused. A replaced
    // logo is never deleted: sent emails, welcome emails included, still load it.
    await setLogo(ctx, { key, contentType, size: bytes.length, width, height });
    return respond(ctx);
  },
  auditTarget: (_input, output) => ({
    targetType: "brand",
    metadata: { contentType: output.logo?.contentType ?? null, size: output.logo?.size ?? null },
  }),
});

export const brandRemoveLogo = defineOperation({
  id: "brand.remove_logo",
  summary: "Remove the brand logo",
  description:
    "Removes the logo from the brand kit. Templates then show no logo. The logo file stays, " +
    "so sent emails and confirmed campaigns keep it.",
  method: "delete",
  path: "/brand/logo",
  scope: "workspace:admin",
  risk: "write",
  mcp: BRAND_WRITE_MCP,
  input: z.object({}),
  output: BrandSchema,
  async handler(_input, ctx) {
    // The logo object stays: emails that were sent with it still load it.
    await setLogo(ctx, null);
    return respond(ctx);
  },
  auditTarget: () => ({ targetType: "brand" }),
});
