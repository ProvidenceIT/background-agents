import { describe, expect, it } from "vitest";
import { frontmatterNodeValue, parseSkillMarkdown } from "./skill-markdown";

function frontmatterOf(block: string) {
  return parseSkillMarkdown(`---\n${block}\n---\nbody\n`).frontmatter;
}

describe("parseSkillMarkdown", () => {
  it("keeps the written text and the YAML 1.2 core type of every scalar", () => {
    const frontmatter = frontmatterOf(
      [
        "version: 1.0",
        "flag: true",
        "empty:",
        "tilde: ~",
        "count: 007",
        'quoted: "true"',
        "folded: >",
        "  one",
        "  two",
      ].join("\n")
    );

    const scalar = (key: string) => {
      const node = frontmatter.get(key);
      if (node?.kind !== "scalar") throw new Error(`${key} is not a scalar`);
      return [node.text, node.value];
    };
    expect(scalar("version")).toEqual(["1.0", 1]);
    expect(scalar("flag")).toEqual(["true", true]);
    expect(scalar("empty")).toEqual(["", null]);
    expect(scalar("tilde")).toEqual(["~", null]);
    expect(scalar("count")).toEqual(["007", 7]);
    expect(scalar("quoted")).toEqual(["true", "true"]);
    expect(scalar("folded")).toEqual(["one two\n", "one two\n"]);
  });

  it("reads nested lists and maps as typed JSON", () => {
    const node = frontmatterOf("paths:\n  - a/**\n  - {glob: b, deep: [1, null]}").get("paths")!;

    expect(frontmatterNodeValue(node, "paths")).toEqual(["a/**", { glob: "b", deep: [1, null] }]);
  });

  it.each([
    ["an alias", "a: &x 1\nb: *x", /anchors are not supported/],
    ["an alias in a nested value", "a: [&x 1, 2]", /anchors are not supported/],
    ["a tag", "a: !!str 1", /tags are not supported/],
    ["a custom tag", "a: !custom x", /tags are not supported|Unresolved tag/],
    ["a duplicate key", "a: 1\na: 2", /unique|duplicate/i],
    ["keys that differ only in type", "true: 1\n'true': 2", /duplicate key/],
    ["a complex key", "? [a]\n: 1", /keys must be strings/],
  ])("rejects %s", (_case, block, message) => {
    expect(() => frontmatterOf(block)).toThrow(message);
  });

  it("refuses non-finite numbers as preserved values", () => {
    const node = frontmatterOf("ratio: .nan").get("ratio")!;

    expect(() => frontmatterNodeValue(node, "ratio")).toThrow(/finite number/);
  });
});
