import { describe, expect, it } from "vitest";
import { csvCell, csvLine, detectDelimiter, parseCsv } from "./csv";

const all = (text: string, delimiter = ",") => parseCsv(text, { final: true, delimiter }).rows;

describe("parseCsv", () => {
  it("reads quoted fields with delimiters, quotes, and line breaks", () => {
    const text =
      'email,note\r\na@example.com,"Hello, ""friend""\nsecond line"\r\nb@example.com,plain\n';
    expect(all(text)).toEqual([
      ["email", "note"],
      ["a@example.com", 'Hello, "friend"\nsecond line'],
      ["b@example.com", "plain"],
    ]);
  });

  it("handles CR line ends, blank lines, and a last row without a line break", () => {
    expect(all("a,b\r1,2\r\n\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(all("")).toEqual([]);
    expect(all("\n\n")).toEqual([]);
    expect(all("a,,\n")).toEqual([["a", "", ""]]);
  });

  it("stops before an unfinished row when more text follows", () => {
    const text = 'a,b\n1,"two\nlines';
    const result = parseCsv(text, { final: false });
    expect(result.rows).toEqual([["a", "b"]]);
    expect(result.consumed).toBe(4);
    // A CR at the end may be the first half of CRLF.
    expect(parseCsv("a,b\r", { final: false })).toEqual({ rows: [], consumed: 0 });
    // A quote at the end may be the first half of "".
    expect(parseCsv('"a"', { final: false })).toEqual({ rows: [], consumed: 0 });
  });

  it("gives the same rows when read in chunks at record boundaries", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [
      `u${i}@example.com`,
      `Name, ${i}`,
      `x\ny${i}`,
    ]);
    const text = rows.map((row) => csvLine(row)).join("");
    const read: string[][] = [];
    let offset = 0;
    while (offset < text.length) {
      const window = text.slice(offset, offset + 97);
      const final = offset + 97 >= text.length;
      const result = parseCsv(window, { final, maxRows: 3 });
      read.push(...result.rows);
      offset += result.consumed;
      if (result.consumed === 0 && final) break;
    }
    expect(read).toEqual(rows);
  });

  it("respects maxRows", () => {
    const result = parseCsv("1\n2\n3\n", { final: true, maxRows: 2 });
    expect(result).toEqual({ rows: [["1"], ["2"]], consumed: 4 });
  });

  it("keeps a stray quote inside an unquoted field as text", () => {
    expect(all('a"b,c\n')).toEqual([['a"b', "c"]]);
  });
});

describe("detectDelimiter", () => {
  it("picks comma, semicolon, or tab from the header", () => {
    expect(detectDelimiter("email,name\n")).toBe(",");
    expect(detectDelimiter("email;name;city\na,b,c")).toBe(";");
    expect(detectDelimiter("email\tname\n")).toBe("\t");
    expect(detectDelimiter('"last, first";email\n')).toBe(";");
    expect(detectDelimiter("email\n")).toBe(",");
  });
});

describe("csvCell", () => {
  it("quotes a cell that a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe(
      `"'=HYPERLINK(""http://evil.example"",""x"")"`,
    );
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe(`"'\rx"`);
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
  });

  it("round-trips through the parser", () => {
    const row = ["a,b", 'say "hi"', "line\nbreak", "=1+1"];
    expect(all(csvLine(row))).toEqual([["a,b", 'say "hi"', "line\nbreak", "'=1+1"]]);
  });
});
