import { describe, expect, it } from "vitest";
import type { SkillImportProvenance } from "@open-inspect/shared/types/skills";
import type { RequestContext } from "../http/request-context";
import {
  PROMPT_LIBRARY_REF_NOT_PINNED,
  PROMPT_LIBRARY_SOURCE_NOT_ALLOWED,
  promptLibraryImportRefusal,
  promptLibraryReimportRefusal,
  promptLibraryResolvedCommitRefusal,
  promptLibrarySkillRepositories,
  promptLibraryUpdateRefusal,
} from "./prompt-library-sources";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ACTOR = {
  provider: "microsoft",
  providerUserId: "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  canonicalUserId: "user-1",
  participantUserId: "microsoft:4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
} as const;

function ctxFor(principal: RequestContext["principal"]): RequestContext {
  return { principal } as RequestContext;
}

const promptLibrary = ctxFor({ kind: "service", service: "prompt-library", actor: ACTOR });
const others: RequestContext[] = [
  ctxFor({ kind: "user", userId: "user-1" }),
  ctxFor({ kind: "service", service: "motion", actor: ACTOR }),
  ctxFor({ kind: "service", service: "web", actor: null }),
];

function recorded(repoOwner: string, repoName: string): SkillImportProvenance {
  return {
    provider: "github",
    repoOwner,
    repoName,
    requestedRef: SHA,
    resolvedRef: SHA,
    commitSha: SHA,
    subdirectory: "skills/pit-example",
    sourceSha256: "b".repeat(64),
    importedAt: 1,
    revisionId: "revision-1",
  };
}

async function refusal(response: Response | null) {
  expect(response?.status).toBe(403);
  return (await response!.json()) as { error: string; code: string };
}

describe("promptLibrarySkillRepositories", () => {
  it("defaults to ProvidenceIT/prompt-library when unset or blank", () => {
    for (const value of [undefined, "", " , ,"]) {
      expect([...promptLibrarySkillRepositories(value)]).toEqual(["providenceit/prompt-library"]);
    }
  });

  it("reads a comma-separated, case-insensitive list", () => {
    expect([
      ...promptLibrarySkillRepositories(" Acme/Skills ,ProvidenceIT/Cursor-Plugins"),
    ]).toEqual(["acme/skills", "providenceit/cursor-plugins"]);
  });
});

describe("promptLibraryImportRefusal", () => {
  const source = (repoOwner: string, repoName: string, ref?: string | null) => ({
    repository: { repoOwner, repoName },
    ref,
  });

  it("admits an allowlisted repository at a full commit SHA", () => {
    expect(
      promptLibraryImportRefusal(
        promptLibrary,
        undefined,
        source("providenceit", "prompt-library", SHA)
      )
    ).toBeNull();
    expect(
      promptLibraryImportRefusal(promptLibrary, "acme/skills", source("ACME", "Skills", SHA))
    ).toBeNull();
  });

  it("refuses a repository outside the allowlist", async () => {
    const body = await refusal(
      promptLibraryImportRefusal(promptLibrary, undefined, source("acme", "skills", SHA))
    );
    expect(body).toEqual({
      error: "The prompt-library service may not manage skills from acme/skills",
      code: PROMPT_LIBRARY_SOURCE_NOT_ALLOWED,
    });
    // A configured list replaces the default rather than extending it.
    await refusal(
      promptLibraryImportRefusal(
        promptLibrary,
        "acme/skills",
        source("providenceit", "prompt-library", SHA)
      )
    );
  });

  it.each([
    ["no ref", undefined],
    ["a null ref", null],
    ["a branch", "main"],
    ["a tag", "v0.1.0"],
    ["a short SHA", SHA.slice(0, 12)],
    ["an upper-case SHA", SHA.toUpperCase()],
    ["a 64-character SHA", "a".repeat(64)],
  ])("refuses %s as the ref", async (_label, ref) => {
    const body = await refusal(
      promptLibraryImportRefusal(
        promptLibrary,
        undefined,
        source("providenceit", "prompt-library", ref)
      )
    );
    expect(body.code).toBe(PROMPT_LIBRARY_REF_NOT_PINNED);
  });

  it("leaves people and other services alone", () => {
    for (const ctx of others) {
      expect(
        promptLibraryImportRefusal(ctx, undefined, source("acme", "skills", "main"))
      ).toBeNull();
    }
  });
});

describe("promptLibraryReimportRefusal", () => {
  it("admits a skill recorded from an allowlisted repository at a full commit SHA", () => {
    expect(
      promptLibraryReimportRefusal(
        promptLibrary,
        undefined,
        recorded("ProvidenceIT", "prompt-library"),
        SHA
      )
    ).toBeNull();
  });

  it("refuses a skill imported elsewhere or never imported", async () => {
    for (const source of [recorded("acme", "skills"), null]) {
      const body = await refusal(
        promptLibraryReimportRefusal(promptLibrary, undefined, source, SHA)
      );
      expect(body.code).toBe(PROMPT_LIBRARY_SOURCE_NOT_ALLOWED);
    }
  });

  it("refuses a missing or moving ref even when the recorded one was a SHA", async () => {
    for (const ref of [undefined, null, "main"]) {
      const body = await refusal(
        promptLibraryReimportRefusal(
          promptLibrary,
          undefined,
          recorded("providenceit", "prompt-library"),
          ref
        )
      );
      expect(body.code).toBe(PROMPT_LIBRARY_REF_NOT_PINNED);
    }
  });

  it("leaves people and other services alone", () => {
    for (const ctx of others) {
      expect(promptLibraryReimportRefusal(ctx, undefined, null, null)).toBeNull();
    }
  });
});

describe("promptLibraryUpdateRefusal", () => {
  it("admits only skills recorded from an allowlisted repository", async () => {
    expect(
      promptLibraryUpdateRefusal(
        promptLibrary,
        undefined,
        recorded("providenceit", "prompt-library")
      )
    ).toBeNull();
    const handWritten = await refusal(promptLibraryUpdateRefusal(promptLibrary, undefined, null));
    expect(handWritten).toEqual({
      error: "The prompt-library service may only manage skills imported from its repositories",
      code: PROMPT_LIBRARY_SOURCE_NOT_ALLOWED,
    });
    await refusal(promptLibraryUpdateRefusal(promptLibrary, undefined, recorded("acme", "skills")));
  });

  it("leaves people and other services alone", () => {
    for (const ctx of others) expect(promptLibraryUpdateRefusal(ctx, undefined, null)).toBeNull();
  });
});

describe("promptLibraryResolvedCommitRefusal", () => {
  it("admits a read at the commit the ref named", () => {
    expect(promptLibraryResolvedCommitRefusal(promptLibrary, SHA, SHA)).toBeNull();
  });

  it("refuses a ref that resolved to another commit", async () => {
    const body = await refusal(
      promptLibraryResolvedCommitRefusal(promptLibrary, SHA, "f".repeat(40))
    );
    expect(body.code).toBe(PROMPT_LIBRARY_REF_NOT_PINNED);
  });

  it("leaves people and other services alone", () => {
    for (const ctx of others) {
      expect(promptLibraryResolvedCommitRefusal(ctx, "main", SHA)).toBeNull();
    }
  });
});
