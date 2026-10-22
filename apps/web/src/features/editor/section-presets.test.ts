import {
  type BlockNode,
  BRAND_COLOR_TOKENS,
  type ColumnsNode,
  isBlockList,
} from "@envelopen/email-render/blocks/types";
import { describe, expect, it } from "vitest";
import { columnCount, emptyColumn, SECTION_PRESETS, setColumnCount } from "./section-presets";

const text = (value: string) => ({
  type: "paragraph" as const,
  content: [{ type: "text" as const, text: value }],
});

function section(...texts: string[][]): ColumnsNode {
  return {
    type: "columns",
    content: texts.map((items) => ({ type: "column", content: items.map(text) })),
  };
}

describe("section presets", () => {
  it("has the five ready sections of the library", () => {
    expect(SECTION_PRESETS.map((preset) => preset.label)).toEqual([
      "Hero",
      "Text and image",
      "Feature list",
      "Call to action",
      "Footer",
    ]);
  });

  it("gives valid block lists with 1 to 3 columns per section", () => {
    for (const preset of SECTION_PRESETS) {
      const blocks = preset.blocks();
      expect(isBlockList(blocks), preset.id).toBe(true);
      for (const block of blocks) {
        if (block.type !== "columns") continue;
        expect(columnCount(block)).toBeGreaterThanOrEqual(1);
        expect(columnCount(block)).toBeLessThanOrEqual(3);
        for (const column of block.content ?? []) {
          // The schema needs at least one block in each column.
          expect(column.content?.length ?? 0).toBeGreaterThan(0);
          // Columns do not nest.
          expect(column.content?.some((child) => (child.type as string) === "columns")).toBe(false);
        }
      }
    }
  });

  it("returns new objects on each call, so two inserts do not share state", () => {
    const hero = SECTION_PRESETS.find((preset) => preset.id === "hero");
    const first = hero?.blocks() as BlockNode[];
    const second = hero?.blocks() as BlockNode[];
    expect(first).toEqual(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it("uses the brand primary color for buttons", () => {
    const buttons = SECTION_PRESETS.flatMap((preset) => JSON.stringify(preset.blocks())).join();
    expect(buttons).toContain(JSON.stringify(BRAND_COLOR_TOKENS.primary));
  });

  it("has a feature list with three columns", () => {
    const features = SECTION_PRESETS.find((preset) => preset.id === "features")?.blocks() ?? [];
    const columns = features.find((block) => block.type === "columns") as ColumnsNode;
    expect(columnCount(columns)).toBe(3);
  });
});

describe("setColumnCount", () => {
  it("adds empty columns and keeps the content of the existing columns", () => {
    const result = setColumnCount(section(["Left"], ["Right"]), 3);
    expect(result.content).toEqual([
      { type: "column", content: [text("Left")] },
      { type: "column", content: [text("Right")] },
      emptyColumn(),
    ]);
  });

  it("moves the content of removed columns into the last column that stays", () => {
    const result = setColumnCount(section(["A"], ["B1", "B2"], ["C"]), 2);
    expect(result.content).toEqual([
      { type: "column", content: [text("A")] },
      { type: "column", content: [text("B1"), text("B2"), text("C")] },
    ]);
    expect(setColumnCount(section(["A"], ["B"], ["C"]), 1).content).toEqual([
      { type: "column", content: [text("A"), text("B"), text("C")] },
    ]);
  });

  it("drops empty paragraphs of removed columns and of an empty last column", () => {
    const value: ColumnsNode = {
      type: "columns",
      content: [emptyColumn(), { type: "column", content: [text("B")] }, emptyColumn()],
    };
    expect(setColumnCount(value, 1).content).toEqual([{ type: "column", content: [text("B")] }]);
    expect(setColumnCount({ type: "columns", content: [emptyColumn(), emptyColumn()] }, 1)).toEqual(
      { type: "columns", content: [emptyColumn()] },
    );
  });

  it("clamps the count to 1 to 3 and does not change the input", () => {
    const input = section(["A"], ["B"]);
    const copy = structuredClone(input);
    expect(columnCount(setColumnCount(input, 9))).toBe(3);
    expect(columnCount(setColumnCount(input, 0))).toBe(1);
    expect(setColumnCount(input, 2)).toEqual(input);
    expect(input).toEqual(copy);
  });
});
