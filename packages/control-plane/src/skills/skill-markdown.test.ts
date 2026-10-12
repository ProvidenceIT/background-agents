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

  it("keeps numbers JSON would rewrite as the text they were written as", () => {
    const frontmatter = frontmatterOf(
      [
        "version: 1.10",
        "mode: 0755",
        "id: 12345678901234567890",
        "hex: 0x1F",
        "whole: 1.0",
        "count: 3",
        "ratio: 0.5",
        "below: -2",
        "nested: {build: 2.50, steps: [1, 01]}",
      ].join("\n")
    );
    const keptAsText: string[] = [];
    const value = (key: string) =>
      frontmatterNodeValue(frontmatter.get(key)!, key, (path) => keptAsText.push(path));

    expect(
      ["version", "mode", "id", "hex", "whole", "count", "ratio", "below", "nested"].map(value)
    ).toEqual([
      "1.10",
      "0755",
      "12345678901234567890",
      "0x1F",
      "1.0",
      3,
      0.5,
      -2,
      { build: "2.50", steps: [1, "01"] },
    ]);
    expect(keptAsText).toEqual([
      "version",
      "mode",
      "id",
      "hex",
      "whole",
      "nested.build",
      "nested.steps[1]",
    ]);
  });

  it("reads keys written without a value as null", () => {
    const frontmatter = frontmatterOf("tags: {beta, internal}\nmixed: [a, {b}]\n? bare");

    expect(frontmatterNodeValue(frontmatter.get("tags")!, "tags")).toEqual({
      beta: null,
      internal: null,
    });
    expect(frontmatterNodeValue(frontmatter.get("mixed")!, "mixed")).toEqual(["a", { b: null }]);
    expect(frontmatterNodeValue(frontmatter.get("bare")!, "bare")).toBeNull();
  });

  it.each([
    ["null spellings", "~: 1\nnull: 2", ["~", "null"]],
    ["integer spellings", "1: a\n01: b", ["1", "01"]],
  ])("keeps keys that differ as written (%s)", (_case, block, keys) => {
    expect([...frontmatterOf(block).keys()]).toEqual(keys);
  });

  it("refuses a __proto__ key inside a preserved map", () => {
    const node = frontmatterOf("reminder: {__proto__: x, when: always}").get("reminder")!;

    expect(() => frontmatterNodeValue(node, "reminder")).toThrow(/reserved key "__proto__"/);
  });

  it("refuses non-finite numbers as preserved values", () => {
    const node = frontmatterOf("ratio: .nan").get("ratio")!;

    expect(() => frontmatterNodeValue(node, "ratio")).toThrow(/finite number/);
  });
});
