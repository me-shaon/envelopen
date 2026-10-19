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
export { DARK_MEDIA, EMAIL_CSS, forceDarkMode } from "./layout";
export { extractLinks, isTrackableHref, rewriteLinks } from "./links";
export { markdownToFragment, markdownToHtml } from "./markdown";
export {
  type CompiledTemplate,
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
