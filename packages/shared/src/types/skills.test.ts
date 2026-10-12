import { describe, expect, it } from "vitest";
import {
  canonicalSkillFrontmatterJson,
  createSkillInputSchema,
  isDeniedSkillFrontmatterKey,
  MAX_SKILL_FRONTMATTER_BYTES,
  MAX_SKILL_REVISION_BYTES,
  skillFrontmatterKeyProblem,
  skillFrontmatterSchema,
  skillSchema,
  importSkillInputSchema,
  replaceSkillContentAndAssignmentsInputSchema,
  listSkillsResponseSchema,
  sessionSkillSelectionSchema,
  skillContentInputSchema,
  skillImportSourceSchema,
  skillNameSchema,
  skillResolutionPreviewInputSchema,
  skillSummarySchema,
} from "./skills";
import { MAX_TARGET_REPOSITORIES } from "./repositories";

describe("managed skill contracts", () => {
  it("accepts portable names and rejects ambiguous names", () => {
    expect(skillNameSchema.safeParse("acme-code-review").success).toBe(true);
    expect(skillNameSchema.safeParse("Acme Review").success).toBe(false);
    expect(skillNameSchema.safeParse("acme--review").success).toBe(false);
  });

  it("rejects traversal, duplicate files, and executable reference files", () => {
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "../secret", content: "x" }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "SKILL.md/hidden", content: "x" }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [
          { path: "references/checklist.md", content: "one" },
          { path: "references/checklist.md", content: "two" },
        ],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "references/checklist.md", content: "x", executable: true }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [
          { path: "scripts", content: "not a directory" },
          { path: "scripts/run.sh", content: "#!/bin/sh" },
        ],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "invalid \ud800 Unicode",
      }).success
    ).toBe(false);
  });

  it("normalizes omitted content collections and all-session selection", () => {
    const skill = createSkillInputSchema.parse({
      name: "acme-review",
      content: { description: "Review code", body: "Review it." },
    });
    expect(skill.assignments).toEqual([]);
    expect(skill.content.files).toEqual([]);
    expect(skill.content.metadata).toEqual({});
    expect(sessionSkillSelectionSchema.parse({ mode: "all" })).toEqual({ mode: "all" });
  });

  it("bounds repository resolution previews to the session repository contract", () => {
    const repositories = Array.from({ length: MAX_TARGET_REPOSITORIES + 1 }, (_, index) => ({
      repoOwner: "acme",
      repoName: `repo-${index}`,
    }));
    expect(skillResolutionPreviewInputSchema.safeParse({ repositories }).success).toBe(false);
  });

  it("requires a cursor exactly when another skill catalog page exists", () => {
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: false, nextCursor: null }).success
    ).toBe(true);
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: true, nextCursor: "next-skill" })
        .success
    ).toBe(true);
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: true, nextCursor: null }).success
    ).toBe(false);
  });

  it("defaults missing import provenance for rolling response compatibility", () => {
    const summary = skillSummarySchema.parse({
      id: "skill-1",
      name: "acme-review",
      description: "Review code",
      enabled: true,
      currentRevisionId: "revision-1",
      revisionNumber: 1,
      revisionSha256: "a".repeat(64),
      revisionCreatedBy: "user-1",
      creatorDisplayName: null,
      lastEditorDisplayName: null,
      revisionAuthorDisplayName: null,
      assignments: [],
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(summary.source).toBeNull();
  });

  it("requires confirmation of the complete previewed revision", () => {
    const input = {
      source: { repository: { repoOwner: "acme", repoName: "skills" } },
      expectedCommitSha: "a".repeat(40),
      expectedSourceSha256: "b".repeat(64),
    };

    expect(importSkillInputSchema.safeParse(input).success).toBe(false);
    expect(
      importSkillInputSchema.safeParse({ ...input, expectedRevisionSha256: "c".repeat(64) }).success
    ).toBe(true);
  });

  it("validates persisted import provenance invariants", () => {
    const source = {
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: "main",
      resolvedRef: "main",
      commitSha: "a".repeat(40),
      subdirectory: "skills/deploy",
      sourceSha256: "b".repeat(64),
    };

    expect(skillImportSourceSchema.safeParse(source).success).toBe(true);
    expect(skillImportSourceSchema.safeParse({ ...source, provider: "unknown" }).success).toBe(
      false
    );
    expect(skillImportSourceSchema.safeParse({ ...source, commitSha: "not-a-sha" }).success).toBe(
      false
    );
    expect(
      skillImportSourceSchema.safeParse({ ...source, subdirectory: "../deploy" }).success
    ).toBe(false);
  });
});

describe("preserved skill frontmatter", () => {
  const content = { description: "Review code", body: "Follow the checklist." };

  it("defaults to an empty map and keeps typed values", () => {
    expect(skillContentInputSchema.parse(content).frontmatter).toEqual({});
    const parsed = skillContentInputSchema.parse({
      ...content,
      frontmatter: {
        "disable-model-invocation": true,
        "argument-hint": "[branch]",
        paths: ["src/**", "docs/*.md"],
        mode: null,
        priority: 2,
        reminder: { every: 3, text: "check" },
      },
    });
    expect(parsed.frontmatter["disable-model-invocation"]).toBe(true);
    expect(parsed.frontmatter.priority).toBe(2);
  });

  it("rejects reserved, denied and unsafe keys", () => {
    for (const key of ["name", "Description", "metadata"]) {
      expect(skillFrontmatterKeyProblem(key)).toMatch(/structured skill field/);
    }
    for (const key of [
      "allowed-tools",
      "allowed_tools",
      "allowedTools",
      "hooks",
      "Model",
      "effort",
      "context",
    ]) {
      expect(isDeniedSkillFrontmatterKey(key)).toBe(true);
      expect(skillFrontmatterSchema.safeParse({ [key]: "x" }).success).toBe(false);
    }
    for (const key of ["1st", "has space", "a:b", "-dash", "yes", "true", "x".repeat(65)]) {
      expect(skillFrontmatterSchema.safeParse({ [key]: "x" }).success).toBe(false);
    }
    expect(
      skillFrontmatterSchema.safeParse({ when_to_use: "x", "user-invocable": false }).success
    ).toBe(true);
  });

  it("rejects a __proto__ key at any depth instead of dropping it", () => {
    for (const json of [
      '{"__proto__": {"a": 1}}',
      '{"x": {"__proto__": {"a": 1}, "b": 2}}',
      '{"x": [1, {"__proto__": "y"}]}',
    ]) {
      const parsed = skillContentInputSchema.safeParse({
        ...content,
        frontmatter: JSON.parse(json),
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/reserved key "__proto__"/);
    }
  });

  it("leaves frontmatter absent on replace so the current revision's is kept", () => {
    const replace = (frontmatter?: Record<string, unknown>) =>
      replaceSkillContentAndAssignmentsInputSchema.parse({
        content: frontmatter === undefined ? content : { ...content, frontmatter },
        assignments: [],
      }).content.frontmatter;

    expect(replace()).toBeUndefined();
    expect(replace({})).toEqual({});
    expect(replace({ "disable-model-invocation": true })).toEqual({
      "disable-model-invocation": true,
    });
    expect(
      replaceSkillContentAndAssignmentsInputSchema.safeParse({
        content: { ...content, frontmatter: { model: "opus" } },
        assignments: [],
      }).success
    ).toBe(false);
  });

  it("caps nesting depth and serialized size", () => {
    const fourDeep = { a: [{ b: [1] }] };
    expect(skillFrontmatterSchema.safeParse({ deep: fourDeep }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ deep: [fourDeep] }).success).toBe(false);
    expect(
      skillFrontmatterSchema.safeParse({ big: "x".repeat(MAX_SKILL_FRONTMATTER_BYTES) }).success
    ).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ bad: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("counts frontmatter toward the revision byte limit", () => {
    const bodyBytes = MAX_SKILL_REVISION_BYTES - "Review code".length - 20;
    const near = { ...content, body: "x".repeat(bodyBytes) };
    expect(skillContentInputSchema.safeParse(near).success).toBe(true);
    expect(
      skillContentInputSchema.safeParse({ ...near, frontmatter: { reminder: "y".repeat(40) } })
        .success
    ).toBe(false);
  });

  it("serializes canonically with keys in UTF-8 byte order at every level", () => {
    expect(canonicalSkillFrontmatterJson({ b: { z: 1, "\u00e9": 2, a: 3 }, a: [true, null] })).toBe(
      '{"a":[true,null],"b":{"a":3,"z":1,"\u00e9":2}}'
    );
  });

  it("defaults frontmatter on skill reads from an older control plane", () => {
    const parsed = skillSchema.safeParse({
      id: "skill_1",
      name: "review",
      description: "Review",
      enabled: true,
      currentRevisionId: "rev_1",
      revisionNumber: 1,
      revisionSha256: "a".repeat(64),
      revisionCreatedBy: "user_1",
      creatorDisplayName: null,
      lastEditorDisplayName: null,
      revisionAuthorDisplayName: null,
      assignments: [],
      createdBy: "user_1",
      updatedBy: "user_1",
      createdAt: 1,
      updatedAt: 1,
      body: "",
      license: null,
      compatibility: null,
      metadata: {},
      files: [],
    });
    expect(parsed.success && parsed.data.frontmatter).toEqual({});
  });
});
