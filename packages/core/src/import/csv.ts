// A small RFC 4180 CSV reader and writer. No dependency: the import reads the file in
// chunks inside Workflow steps, so the reader must stop at a record boundary and say
// how far it read. It handles quoted fields with delimiters, quotes (""), and line
// breaks, CRLF, LF, and CR line ends, and blank lines. It is lenient: a quote inside an
// unquoted field is kept as text, and text after a closing quote joins the field.

export const BOM = "﻿";

export interface CsvParseOptions {
  delimiter?: string;
  /** True when the text runs to the end of the file. Otherwise an unfinished last record is left for the next chunk. */
  final: boolean;
  /** Stop after this many records. */
  maxRows?: number;
}

export interface CsvParseResult {
  rows: string[][];
  /** Characters of `text` that the returned rows cover. The next chunk starts here. */
  consumed: number;
}

export function parseCsv(text: string, options: CsvParseOptions): CsvParseResult {
  const delimiter = options.delimiter ?? ",";
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  let consumed = 0;
  let i = 0;

  const endRecord = (next: number) => {
    row.push(field);
    // A blank line is no record.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    field = "";
    fieldStart = true;
    consumed = next;
  };

  while (i < text.length && rows.length < maxRows) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        // A quote at the end of the chunk may be the first half of "". Wait for more text.
        if (i + 1 >= text.length && !options.final) break;
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && i + 1 >= text.length && !options.final) break;
      const next = char === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      endRecord(next);
      i = next;
      continue;
    }
    field += char;
    fieldStart = false;
    i += 1;
  }

  // The last record of the file may have no line break.
  if (options.final && i >= text.length && rows.length < maxRows) {
    if (field !== "" || row.length > 0 || inQuotes) endRecord(text.length);
    consumed = text.length;
  }
  return { rows, consumed };
}

const DELIMITERS = [",", ";", "\t"] as const;

/** Picks the delimiter that splits the header row into the most columns. Comma wins ties. */
export function detectDelimiter(text: string): string {
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = parseCsv(text, { final: true, maxRows: 1, delimiter }).rows[0]?.length ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

// Spreadsheet apps run a cell that starts with one of these as a formula (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. A value that a spreadsheet would read as a formula gets a leading
 * quote, so it shows as text. A value with a delimiter, a quote, or a line break is quoted.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(cells: ReadonlyArray<string | number | null | undefined>): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}
