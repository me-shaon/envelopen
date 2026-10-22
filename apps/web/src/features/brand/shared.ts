import type { SocialNetwork } from "@envelopen/email-render/blocks/types";
import { type BrandSnapshot, DEFAULT_BRAND } from "@envelopen/email-render/brand";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { Schemas } from "@/api/client";
import { brandQuery } from "@/api/queries";
import { useCurrentWorkspace } from "@/components/workspace-context";

// The brand kit in the admin app (U13). Drafts and previews fill the `{{ brand.* }}`
// tokens with the live brand. The Worker fills a confirmed campaign from its snapshot.

export type Brand = Schemas["Brand"];

export const NETWORK_LABELS: Record<SocialNetwork, string> = {
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  github: "GitHub",
};

/** The brand values that fill the tokens, from the brand kit of the API. */
export function snapshotOfBrand(brand: Brand | undefined): BrandSnapshot {
  if (!brand) return DEFAULT_BRAND;
  return {
    name: brand.tokens.name,
    logoUrl: brand.logo?.url ?? null,
    logoKey: null,
    colorPrimary: brand.colorPrimary,
    colorAccent: brand.colorAccent,
    font: brand.font,
    footer: brand.footer,
    address: brand.address,
    social: brand.social,
  };
}

/** The live brand of the current workspace. Defaults until it loads. */
export function useLiveBrand(): BrandSnapshot {
  const { current } = useCurrentWorkspace();
  const brand = useQuery(brandQuery(current.id));
  return snapshotOfBrand(brand.data);
}

/** The live brand for the editor canvas. The block views read it. */
export const BrandContext = createContext<BrandSnapshot>(DEFAULT_BRAND);

export function useBrand(): BrandSnapshot {
  return useContext(BrandContext);
}
