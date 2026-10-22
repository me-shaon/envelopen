// Worker-safe entry: no React, no editor. The browser imports the renderer from
// `@envelopen/email-render/render` and the blocks from `@envelopen/email-render/blocks`.
export {
  BLOCK_TYPES,
  type BlockNode,
  EDITOR_VERSION,
  type EmailDocument,
  isBlockList,
  isEmailDocument,
} from "./blocks/types";
export {
  applyBrand,
  BRAND_ADDRESS_MAX,
  BRAND_FONT_IDS,
  BRAND_FONTS,
  BRAND_FOOTER_MAX,
  BRAND_NAME_MAX,
  BRAND_URL_MAX,
  type BrandFontId,
  type BrandSnapshot,
  brandFontStack,
  brandUrl,
  DEFAULT_BRAND,
  hasBrandTokens,
  isBrandFont,
  normalizeHexColor,
  parseBrandSnapshot,
} from "./brand";
export { DARK_MEDIA, EMAIL_CSS, forceDarkMode } from "./layout";
export { extractLinks, isTrackableHref, rewriteLinks } from "./links";
export { markdownToFragment, markdownToHtml } from "./markdown";
export {
  BRAND_TAGS,
  type BrandTag,
  type ChoiceOption,
  type CompiledTemplate,
  choiceIds,
  choiceText,
  compile,
  decodeEntities,
  escapeHtml,
  fill,
  type MergeMode,
  type MergeTag,
  type MergeValues,
  mergeTagNames,
  mergeTagText,
  missingMergeTags,
  RESERVED_TAGS,
  recordValues,
  renderMergeTags,
  STANDARD_FIELDS,
} from "./merge-tags";
export {
  type PersonalizedMessage,
  type PreparedMessage,
  type PrepareOptions,
  personalize,
  prepareMessage,
  previewValues,
  type Recipient,
} from "./personalize";
export { safeUrl, sanitizeHtml, unsafeCss } from "./sanitize";
export { htmlToText } from "./text";
export {
  createTokenSigner,
  type RecipientRef,
  TOKEN_KEY_LABEL,
  type TokenKey,
  TokenKeyError,
  type TokenSigner,
  tokenKeysFromEnv,
  type VerifiedToken,
} from "./tokens";
