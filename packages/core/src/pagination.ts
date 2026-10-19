import { z } from "zod";
import { OperationError } from "./errors";

// Cursor pagination (R58). Lists order by the integer primary key, so the order is
// stable: rows inserted during paging get larger ids and never shift earlier pages.
// The cursor is opaque to clients. It encodes the id of the last row on the page.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Input fields for a list operation. Spread them into the operation's input object. */
export const pageInputShape = {
  cursor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .meta({ description: "The `nextCursor` value from the previous page." }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .meta({ description: `Items per page, at most ${MAX_PAGE_SIZE}.` }),
};

/** The output schema of a list operation. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .meta({ description: "Pass as `cursor` to get the next page. Null on the last page." }),
  });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function toBase64Url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
}

export function encodeCursor(id: number): string {
  return toBase64Url(JSON.stringify({ id }));
}

/** Returns the id in the cursor. Throws `invalid_input` for a cursor that Envelopen did not make. */
export function decodeCursor(cursor: string): number {
  let id: unknown;
  try {
    id = (JSON.parse(fromBase64Url(cursor)) as { id?: unknown }).id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
    throw new OperationError("invalid_input", "The cursor is not valid.");
  }
  return id;
}

/**
 * Reads the page input. Query `take` rows (one more than the limit) after `afterId`,
 * ordered by id, and pass the rows to `toPage`.
 */
export function pageParams(input: { cursor?: string | undefined; limit: number }): {
  afterId: number | null;
  take: number;
} {
  return {
    afterId: input.cursor === undefined ? null : decodeCursor(input.cursor),
    take: input.limit + 1,
  };
}

/** Cuts the extra row and sets the cursor when there is a next page. */
export function toPage<R, T>(
  rows: readonly R[],
  limit: number,
  idOf: (row: R) => number,
  map: (row: R) => T,
): Page<T> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(idOf(last)) : null,
  };
}
