/**
 * Reader for the YAML frontmatter in portable `SKILL.md` files.
 *
 * The YAML parser owns syntax, scalar folding and YAML 1.2 core typing. This
 * module owns the much smaller product policy: plain data only — no aliases,
 * anchors, custom tags or duplicate keys anywhere in the block.
 *
 * Every scalar keeps both readings. `text` is the scalar as written (after
 * folding), which is what the mapped string fields and `metadata` store, so
 * `version: 1.0` stays `"1.0"`. `value` is the core-typed reading, which is
 * what preserved frontmatter stores, so `disable-model-invocation: true`
 * stays a boolean.
 */

import type { SkillFrontmatterValue } from "@open-inspect/shared/types/skills";
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from "yaml";

/** One frontmatter value, as plain data with both scalar readings. */
export type SkillFrontmatterNode =
  | { kind: "scalar"; text: string; value: null | boolean | number | string }
  | { kind: "sequence"; items: SkillFrontmatterNode[] }
  | { kind: "map"; entries: [string, SkillFrontmatterNode][] };

export interface ParsedSkillMarkdown {
  frontmatter: Map<string, SkillFrontmatterNode>;
  body: string;
}

export class SkillMarkdownError extends Error {}

const FRONTMATTER_FENCE = /^(?:---|\.\.\.)\s*$/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function nodeLabel(path: string): string {
  return path ? `frontmatter "${path}"` : "frontmatter";
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Reject YAML graph and tag features before reading a node's value. */
function assertPlainNode(node: Node, path: string): void {
  if (isAlias(node)) {
    throw new SkillMarkdownError(`YAML aliases are not supported in ${nodeLabel(path)}`);
  }
  if ("anchor" in node && node.anchor) {
    throw new SkillMarkdownError(`YAML anchors are not supported in ${nodeLabel(path)}`);
  }
  if (node.tag) {
    throw new SkillMarkdownError(`YAML tags are not supported in ${nodeLabel(path)}`);
  }
}

function assertUnicode(text: string, path: string): void {
  if (!hasWellFormedUnicode(text)) {
    throw new SkillMarkdownError(`${nodeLabel(path)} must contain valid Unicode`);
  }
}

/** A map key as written. Keys are read as text, so `1:` and `"1":` are the same key. */
function keyText(value: unknown, path: string): string {
  if (!isNode(value)) throw new SkillMarkdownError(`${nodeLabel(path)} has an empty key`);
  const node: Node = value;
  assertPlainNode(node, path);
  if (!isScalar(node)) {
    throw new SkillMarkdownError(`${nodeLabel(path)} keys must be strings`);
  }
  const text = node.source ?? String(node.value);
  assertUnicode(text, path);
  return text;
}

function readNode(value: unknown, path: string): SkillFrontmatterNode {
  if (!isNode(value)) throw new SkillMarkdownError(`${nodeLabel(path)} must not be empty`);
  const node: Node = value;
  assertPlainNode(node, path);
  if (isScalar(node)) {
    const typed = node.value;
    if (
      typed !== null &&
      typeof typed !== "boolean" &&
      typeof typed !== "number" &&
      typeof typed !== "string"
    ) {
      throw new SkillMarkdownError(`${nodeLabel(path)} has an unsupported scalar type`);
    }
    const text = node.source ?? String(typed ?? "");
    assertUnicode(text, path);
    if (typeof typed === "string") assertUnicode(typed, path);
    return { kind: "scalar", text, value: typed };
  }
  if (isSeq(node)) {
    return {
      kind: "sequence",
      items: node.items.map((item, index) => readNode(item, `${path}[${index}]`)),
    };
  }
  if (isMap(node)) {
    const seen = new Set<string>();
    const entries = node.items.map((pair): [string, SkillFrontmatterNode] => {
      const key = keyText(pair.key, path);
      const childPath = path ? `${path}.${key}` : key;
      if (seen.has(key)) {
        throw new SkillMarkdownError(`${nodeLabel(childPath)} is a duplicate key`);
      }
      seen.add(key);
      return [key, readNode(pair.value, childPath)];
    });
    return { kind: "map", entries };
  }
  throw new SkillMarkdownError(`${nodeLabel(path)} has an unsupported YAML node`);
}

/**
 * The core-typed JSON reading of a node, as preserved frontmatter stores it.
 *
 * @throws SkillMarkdownError for values JSON cannot represent (`.inf`, `.nan`).
 */
export function frontmatterNodeValue(
  node: SkillFrontmatterNode,
  path: string
): SkillFrontmatterValue {
  if (node.kind === "scalar") {
    if (typeof node.value === "number" && !Number.isFinite(node.value)) {
      throw new SkillMarkdownError(`${nodeLabel(path)} must be a finite number`);
    }
    return node.value;
  }
  if (node.kind === "sequence") {
    return node.items.map((item, index) => frontmatterNodeValue(item, `${path}[${index}]`));
  }
  // fromEntries defines own properties, so a "__proto__" key stays data.
  return Object.fromEntries(
    node.entries.map(([key, child]) => [key, frontmatterNodeValue(child, `${path}.${key}`)])
  );
}

/** Split a `SKILL.md` into validated frontmatter entries and its Markdown body. */
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const lines = stripBom(markdown).split("\n");
  if (!/^---\s*$/.test(lines[0] ?? "")) {
    throw new SkillMarkdownError("SKILL.md must start with a --- frontmatter block");
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line));
  if (closingIndex === -1) {
    throw new SkillMarkdownError("SKILL.md frontmatter block is not closed");
  }

  const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new SkillMarkdownError(problem.message);
  if (!document.contents || !isMap(document.contents)) {
    throw new SkillMarkdownError("SKILL.md frontmatter must be a map");
  }

  const root = readNode(document.contents, "");
  if (root.kind !== "map") throw new SkillMarkdownError("SKILL.md frontmatter must be a map");
  return {
    frontmatter: new Map(root.entries),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}
