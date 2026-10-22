import type { BrandLogoContentType } from "@envelopen/db";
import { LOGO_TYPES } from "./model";

// Logo files (U13). The type comes from the magic bytes, never from the file name or a
// declared type. PNG, JPEG, GIF, and WebP pass. Anything else fails, SVG too: an SVG is
// a document that can hold scripts. A declared type or a file extension that names
// another type fails as well, so a file named `logo.png` that holds HTML is refused.
// The width and the height are read from the header when it is cheap.

export interface SniffedImage {
  contentType: BrandLogoContentType;
  width: number | null;
  height: number | null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((value, index) => bytes[at + index] === value);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 0x10000 + u16be(b, at + 2);

function size(width: number, height: number): { width: number | null; height: number | null } {
  const ok = (value: number) => Number.isInteger(value) && value > 0 && value <= 65_535;
  return ok(width) && ok(height) ? { width, height } : { width: null, height: null };
}

function jpegSize(bytes: Uint8Array) {
  // Walk the markers to the first start-of-frame segment.
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return size(0, 0);
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return size(u16be(bytes, at + 7), u16be(bytes, at + 5));
    if (length < 2) return size(0, 0);
    at += 2 + length;
  }
  return size(0, 0);
}

function webpSize(bytes: Uint8Array) {
  if (startsWith(bytes, ascii("VP8X"), 12)) return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  if (startsWith(bytes, ascii("VP8L"), 12)) {
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    return size(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)));
  }
  if (startsWith(bytes, ascii("VP8 "), 12)) {
    return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  return null;
}

/** The image type and size from the magic bytes, or null for any other file. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // The first chunk of a PNG is IHDR: width and height, 4 bytes each.
    if (!startsWith(bytes, ascii("IHDR"), 12)) return null;
    return { contentType: "image/png", ...size(u32be(bytes, 16), u32be(bytes, 20)) };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: "image/jpeg", ...jpegSize(bytes) };
  }
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return { contentType: "image/gif", ...size(u16le(bytes, 6), u16le(bytes, 8)) };
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    const dimensions = webpSize(bytes);
    if (!dimensions) return null;
    return { contentType: "image/webp", ...dimensions };
  }
  return null;
}

const EXTENSIONS: Readonly<Record<string, BrandLogoContentType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type LogoCheck =
  | { ok: true; image: SniffedImage }
  | { ok: false; message: string; field: "content" | "filename" | "contentType" };

/** Checks an uploaded logo: size, magic bytes, and the declared type and file name. */
export function checkLogo(
  bytes: Uint8Array,
  declared: { filename?: string | null | undefined; contentType?: string | null | undefined },
  maxBytes: number,
): LogoCheck {
  if (bytes.length === 0) return { ok: false, message: "The file is empty.", field: "content" };
  if (bytes.length > maxBytes) {
    return { ok: false, message: "The logo is larger than 1 MB.", field: "content" };
  }
  const image = sniffImage(bytes);
  if (!image) {
    return {
      ok: false,
      message: "The logo must be a PNG, JPEG, GIF, or WebP image. SVG is not accepted.",
      field: "content",
    };
  }
  const type = declared.contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    type &&
    type !== image.contentType &&
    !(type === "image/jpg" && image.contentType === "image/jpeg")
  ) {
    return {
      ok: false,
      message: `The file is a ${LOGO_TYPES[image.contentType].toUpperCase()} image, not ${type}.`,
      field: "contentType",
    };
  }
  const extension = declared.filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension && EXTENSIONS[extension] !== image.contentType) {
    return {
      ok: false,
      message: `The file name ends in .${extension}, but the file is a ${LOGO_TYPES[image.contentType].toUpperCase()} image.`,
      field: "filename",
    };
  }
  return { ok: true, image };
}
