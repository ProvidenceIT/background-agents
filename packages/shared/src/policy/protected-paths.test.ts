import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTECTED_PATHS,
  matchProtectedPaths,
  repoPathPolicyInputSchema,
} from "./protected-paths";

describe("matchProtectedPaths with the defaults", () => {
  it("tags each protected file with its FACTORY_RULES category", () => {
    expect(
      matchProtectedPaths([
        ".github/workflows/ci.yml",
        "terraform/d1/migrations/0200_x.sql",
        "packages/control-plane/src/auth/github-app.ts",
        "src/billing/invoice.ts",
        "certs/dev.pem",
        "packages/web/.env.local",
        "docs/CODEOWNERS",
        "packages/docs/AGENTS.md",
      ])
    ).toEqual([
      { path: ".github/workflows/ci.yml", category: "governance", glob: ".github/workflows/**" },
      {
        path: "terraform/d1/migrations/0200_x.sql",
        category: "db_migration",
        glob: "**/migrations/**",
      },
      {
        path: "packages/control-plane/src/auth/github-app.ts",
        category: "auth",
        glob: "**/auth/**",
      },
      { path: "src/billing/invoice.ts", category: "billing", glob: "**/billing/**" },
      { path: "certs/dev.pem", category: "secrets", glob: "*.pem" },
      { path: "packages/web/.env.local", category: "secrets", glob: ".env*" },
      { path: "docs/CODEOWNERS", category: "governance", glob: "CODEOWNERS" },
      { path: "packages/docs/AGENTS.md", category: "governance", glob: "AGENTS.md" },
    ]);
  });

  it("reports one file under every category it falls in", () => {
    expect(matchProtectedPaths(["deploy/migrations/0001.sql"])).toEqual([
      { path: "deploy/migrations/0001.sql", category: "governance", glob: "deploy/**" },
      { path: "deploy/migrations/0001.sql", category: "db_migration", glob: "**/migrations/**" },
    ]);
  });

  it("leaves ordinary source files and near-miss names alone", () => {
    expect(
      matchProtectedPaths([
        "src/index.ts",
        "src/oauth/callback.ts",
        "src/deploy-helpers.ts",
        "docs/environment.md",
        "README.md",
      ])
    ).toEqual([]);
  });

  it("applies extra repo globs alongside the defaults", () => {
    expect(
      matchProtectedPaths(
        ["infra/main.tf", "src/index.ts"],
        [...DEFAULT_PROTECTED_PATHS, { glob: "infra/**", category: "governance" }]
      )
    ).toEqual([{ path: "infra/main.tf", category: "governance", glob: "infra/**" }]);
  });
});

describe("repoPathPolicyInputSchema", () => {
  it("accepts categorized relative globs and trims them", () => {
    expect(
      repoPathPolicyInputSchema.parse({ globs: [{ glob: " infra/** ", category: "governance" }] })
    ).toEqual({ globs: [{ glob: "infra/**", category: "governance" }] });
  });

  it("rejects unknown categories, absolute globs and extra keys", () => {
    expect(
      repoPathPolicyInputSchema.safeParse({ globs: [{ glob: "x/**", category: "other" }] }).success
    ).toBe(false);
    expect(
      repoPathPolicyInputSchema.safeParse({ globs: [{ glob: "/etc/**", category: "secrets" }] })
        .success
    ).toBe(false);
    expect(
      repoPathPolicyInputSchema.safeParse({
        globs: [{ glob: "x/**", category: "secrets", extra: 1 }],
      }).success
    ).toBe(false);
  });
});
