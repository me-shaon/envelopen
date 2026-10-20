// A small JSONC reader and editor for wrangler.jsonc, with no dependencies.
//
// - parseJsonc(text) reads JSON with `//` and `/* */` comments and trailing commas. It
//   returns the value and a tree of nodes with the start and end offset of each value.
// - editJsonc(text, next) rewrites `text` so that it holds the value `next`. It keeps the
//   original text (comments, spacing, key order) for every part that does not change, and
//   writes formatted JSON only for the values that changed.
//
// The update scripts run in a fresh checkout before `pnpm install`, so they cannot use
// a JSONC package from node_modules.

export class JsoncError extends Error {}

/** Parses JSONC. Returns `{ value, node }`. Throws JsoncError on bad input. */
export function parseJsonc(text) {
  let i = 0;

  function fail(message) {
    const line = text.slice(0, i).split("\n").length;
    throw new JsoncError(`${message} (line ${line})`);
  }

  function skip() {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") {
        i++;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) fail("Unclosed block comment");
        i = end + 2;
      } else {
        return;
      }
    }
  }

  function parseString() {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
      } else if (c === '"') {
        i++;
        try {
          return { value: JSON.parse(text.slice(start, i)), start, end: i };
        } catch {
          fail("Bad string");
        }
      } else if (c === "\n") {
        fail("Line break in string");
      } else {
        i++;
      }
    }
    return fail("Unclosed string");
  }

  function parseValue() {
    skip();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const props = [];
      const value = {};
      for (;;) {
        skip();
        if (text[i] === "}") break;
        if (text[i] !== '"') fail("Expected a key");
        const key = parseString();
        skip();
        if (text[i] !== ":") fail("Expected ':'");
        i++;
        const node = parseValue();
        props.push({ key: key.value, keyStart: key.start, node });
        value[key.value] = node.value;
        skip();
        if (text[i] === ",") {
          i++;
        } else if (text[i] !== "}") {
          fail("Expected ',' or '}'");
        }
      }
      i++;
      return { type: "object", value, props, start, end: i };
    }
    if (c === "[") {
      i++;
      const items = [];
      for (;;) {
        skip();
        if (text[i] === "]") break;
        items.push(parseValue());
        skip();
        if (text[i] === ",") {
          i++;
        } else if (text[i] !== "]") {
          fail("Expected ',' or ']'");
        }
      }
      i++;
      return { type: "array", value: items.map((n) => n.value), items, start, end: i };
    }
    if (c === '"') {
      const s = parseString();
      return { type: "string", value: s.value, start, end: s.end };
    }
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) fail("Unexpected character");
    i += match[0].length;
    return { type: "literal", value: JSON.parse(match[0]), start, end: i };
  }

  const node = parseValue();
  skip();
  if (i < text.length) fail("Unexpected text after the value");
  return { value: node.value, node };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function indentAt(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
}

function format(value, indent) {
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
}

function formatInline(value) {
  return JSON.stringify(value, null, 1).replace(/\n\s*/g, " ");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Returns `text` changed to hold `next`. Unchanged values keep their text and comments.
 * Objects keep the text of each kept key and get new keys at the end. Arrays keep their
 * items and get new items at the end. Other changes are written as formatted JSON.
 */
export function editJsonc(text, next) {
  const { node } = parseJsonc(text);

  function render(n, value) {
    if (deepEqual(n.value, value)) return text.slice(n.start, n.end);
    const indent = indentAt(text, n.start);
    if (n.type === "object" && isPlainObject(value) && n.props.length > 0) {
      const leads = [];
      for (let j = 0; j < n.props.length; j++) {
        const from = j === 0 ? n.start + 1 : n.props[j - 1].node.end;
        let lead = text.slice(from, n.props[j].keyStart);
        if (j > 0) {
          const comma = /^\s*,/.exec(lead);
          if (!comma) return format(value, indent);
          lead = lead.slice(comma[0].length);
        }
        leads.push(lead);
      }
      const last = n.props[n.props.length - 1].node.end;
      const tail = text.slice(last, n.end - 1).replace(/^(\s*),/, "$1");
      const childIndent = indentAt(text, n.props[0].keyStart) || `${indent}  `;
      const pieces = [];
      n.props.forEach((p, j) => {
        if (!Object.hasOwn(value, p.key)) return;
        const keyText = text.slice(p.keyStart, p.node.start);
        pieces.push(leads[j] + keyText + render(p.node, value[p.key]));
      });
      const known = new Set(n.props.map((p) => p.key));
      const multiline = text.slice(n.start, n.end).includes("\n");
      for (const [key, v] of Object.entries(value)) {
        if (known.has(key)) continue;
        pieces.push(
          multiline
            ? `\n${childIndent}${JSON.stringify(key)}: ${format(v, childIndent)}`
            : ` ${JSON.stringify(key)}: ${formatInline(v)}`,
        );
      }
      if (pieces.length === 0) return "{}";
      return `{${pieces.join(",")}${tail}}`;
    }
    if (n.type === "array" && Array.isArray(value) && value.length >= n.items.length) {
      if (n.items.length === 0) return format(value, indent);
      let out = text.slice(n.start, n.items[0].start);
      n.items.forEach((item, k) => {
        out += render(item, value[k]);
        if (k < n.items.length - 1) out += text.slice(item.end, n.items[k + 1].start);
      });
      const childIndent = indentAt(text, n.items[0].start);
      const multiline = text.slice(n.start, n.items[0].start).includes("\n");
      for (const extra of value.slice(n.items.length)) {
        out += multiline ? `,\n${childIndent}` : ", ";
        out += multiline ? format(extra, childIndent) : formatInline(extra);
      }
      const last = n.items[n.items.length - 1].end;
      return out + text.slice(last, n.end).replace(/^(\s*),/, "$1");
    }
    return format(value, indent);
  }

  return text.slice(0, node.start) + render(node, next) + text.slice(node.end);
}
