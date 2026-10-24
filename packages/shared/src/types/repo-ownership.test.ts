import { describe, expect, it } from "vitest";
import {
  codeownersHandles,
  defaultCodeowners,
  effectiveRepoClass,
  parseCodeowners,
  repoOwnershipInputSchema,
} from "./repo-ownership";

describe("effectiveRepoClass", () => {
  it("treats an unclassified repository as a client repository", () => {
    expect(effectiveRepoClass(null)).toBe("client");
    expect(effectiveRepoClass(undefined)).toBe("client");
    expect(effectiveRepoClass("playground")).toBe("playground");
    expect(effectiveRepoClass("internal")).toBe("internal");
  });
});

describe("parseCodeowners", () => {
  const FILE = [
    "# Default owners for everything",
    "*       @ProvidenceIT/platform",
    "",
    "   # indented comment",
    "/docs/  @bramdokman docs@example.com   # trailing comment",
    "*.ts    @ProvidenceIT/platform @robdeman",
    "\\#notes.md @bramdokman",
    "/vendor/",
    "!/keep/ @bramdokman",
    "/src/[ab]/ @bramdokman",
    "/bad/ not-a-handle",
    "/teams/ @ProvidenceIT/web_team.core",
  ].join("\r\n");

  it("parses default owner, path owners, team, user and email handles, skipping comments", () => {
    expect(parseCodeowners(FILE)).toEqual([
      { pattern: "*", owners: [{ kind: "team", handle: "@ProvidenceIT/platform" }] },
      {
        pattern: "/docs/",
        owners: [
          { kind: "user", handle: "@bramdokman" },
          { kind: "email", handle: "docs@example.com" },
        ],
      },
      {
        pattern: "*.ts",
        owners: [
          { kind: "team", handle: "@ProvidenceIT/platform" },
          { kind: "user", handle: "@robdeman" },
        ],
      },
      { pattern: "#notes.md", owners: [{ kind: "user", handle: "@bramdokman" }] },
      { pattern: "/vendor/", owners: [] },
      { pattern: "/teams/", owners: [{ kind: "team", handle: "@ProvidenceIT/web_team.core" }] },
    ]);
  });

  it("names the last * rule's owners as the default owners", () => {
    const rules = parseCodeowners("* @a\n/x/ @b\n* @org/c @d\n");
    expect(defaultCodeowners(rules)).toEqual([
      { kind: "team", handle: "@org/c" },
      { kind: "user", handle: "@d" },
    ]);
    expect(defaultCodeowners(parseCodeowners("/x/ @b"))).toEqual([]);
    expect(codeownersHandles(rules)).toEqual(["@a", "@b", "@org/c", "@d"]);
  });

  it("returns no rules for an empty or comment-only file", () => {
    expect(parseCodeowners("")).toEqual([]);
    expect(parseCodeowners("# nothing here\n\n")).toEqual([]);
  });
});

describe("repoOwnershipInputSchema", () => {
  const valid = {
    ownerTeamId: "team-1",
    tier: "T1",
    repoClass: "internal",
    domain: "platform",
    dependsOn: ["ProvidenceIT/Prompt-Library"],
  };

  it("normalizes dependsOn and accepts null for every field", () => {
    expect(repoOwnershipInputSchema.parse(valid).dependsOn).toEqual([
      "providenceit/prompt-library",
    ]);
    expect(
      repoOwnershipInputSchema.parse({
        ownerTeamId: null,
        tier: null,
        repoClass: null,
        domain: null,
        dependsOn: null,
      }).repoClass
    ).toBeNull();
  });

  it("rejects an unknown class, tier, field or repository name", () => {
    expect(repoOwnershipInputSchema.safeParse({ ...valid, repoClass: "public" }).success).toBe(
      false
    );
    expect(repoOwnershipInputSchema.safeParse({ ...valid, tier: "T4" }).success).toBe(false);
    expect(repoOwnershipInputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(repoOwnershipInputSchema.safeParse({ ...valid, dependsOn: ["nope"] }).success).toBe(
      false
    );
  });
});
