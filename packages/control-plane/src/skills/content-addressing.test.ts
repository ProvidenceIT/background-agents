import { describe, expect, it } from "vitest";
import { skillContentInputSchema } from "@open-inspect/shared/types/skills";
import { parse } from "yaml";
import { buildSkillRevision } from "./content-addressing";

function content(input: Record<string, unknown>) {
  return skillContentInputSchema.parse(input);
}

const MINIMAL = { description: "Deploys the API", body: "# Deploy\n" };
const FULL = {
  description: 'Reviews "quoted" pull requests: carefully',
  body: "## Workflow\n\n1. Read the diff.\n",
  license: "Apache-2.0",
  compatibility: "Requires gh",
  metadata: { team: "platform", "credits.author": "Matt", ä: "x" },
  files: [
    { path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n", executable: true },
    { path: "references/guide.md", content: "guide\n", executable: false },
  ],
};

async function skillMarkdown(input: Record<string, unknown>): Promise<string> {
  const revision = await buildSkillRevision("review-pr", content(input));
  return revision.files.find((file) => file.path === "SKILL.md")!.content;
}

describe("buildSkillRevision", () => {
  // Digests computed by the renderer before preserved frontmatter existed
  // (sf/main 39690fa4). Every stored revision's revisionSha256 depends on
  // empty frontmatter adding zero bytes to SKILL.md.
  it.each([
    ["minimal", MINIMAL, "eca1ce43350574ecf83487928213d77aa002aee006243d8668844881fb15566d", 64],
    ["full", FULL, "caccc6e5fc7842896bf3d5b3b302784dfabb5468f0c27e305486bec856498ecf", 259],
  ])("keeps the pre-frontmatter digest for %s content", async (_name, input, digest, bytes) => {
    const revision = await buildSkillRevision("review-pr", content(input));
    expect(revision.revisionSha256).toBe(digest);
    expect(revision.totalBytes).toBe(bytes);

    const explicit = await buildSkillRevision("review-pr", content({ ...input, frontmatter: {} }));
    expect(explicit.revisionSha256).toBe(digest);
  });

  it("renders preserved frontmatter after metadata with name first and keys byte-ordered", async () => {
    const markdown = await skillMarkdown({
      ...FULL,
      frontmatter: {
        "disable-model-invocation": true,
        "argument-hint": "[branch]",
        paths: ["src/**", "docs/*.md"],
        mode: null,
        priority: 2,
        reminder: { z: 1, a: [false, "x"] },
      },
    });

    expect(markdown.split("\n").slice(0, 16)).toEqual([
      "---",
      "name: review-pr",
      'description: "Reviews \\"quoted\\" pull requests: carefully"',
      'license: "Apache-2.0"',
      'compatibility: "Requires gh"',
      "metadata:",
      '  "credits.author": "Matt"',
      '  "team": "platform"',
      '  "ä": "x"',
      'argument-hint: "[branch]"',
      "disable-model-invocation: true",
      "mode: null",
      'paths: ["src/**", "docs/*.md"]',
      "priority: 2",
      'reminder: {"a": [false, "x"], "z": 1}',
      "---",
    ]);
  });

  it("renders frontmatter any YAML 1.2 reader types the same way", async () => {
    const frontmatter = {
      "disable-model-invocation": true,
      icon: "🚀",
      color: "#ff0000",
      reminder: 'line one\nline two: "quoted" \u0085 \u2028 end',
      nested: { "key with: colon": [1, 2.5, -3, null, { deep: "yes" }] },
    };
    const markdown = await skillMarkdown({ ...MINIMAL, frontmatter });
    const block = markdown.split("---\n")[1];

    expect(markdown).not.toMatch(/[\u0085\u2028]/);
    expect(parse(block)).toEqual({
      name: "review-pr",
      description: MINIMAL.description,
      ...frontmatter,
    });
  });

  it("produces the same digest for the same frontmatter in any key order", async () => {
    const left = await buildSkillRevision(
      "review-pr",
      content({ ...MINIMAL, frontmatter: { b: { y: 1, x: 2 }, a: true } })
    );
    const right = await buildSkillRevision(
      "review-pr",
      content({ ...MINIMAL, frontmatter: { a: true, b: { x: 2, y: 1 } } })
    );
    expect(left.revisionSha256).toBe(right.revisionSha256);
  });
});
