import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { skillImportPreviewResponseSchema, skillSchema } from "@open-inspect/shared/types/skills";
import type * as AuthenticateModule from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { SkillStore } from "../db/skills";
import { createControlPlaneApp } from "../routing/hono-app";
import type * as SourceControlModule from "../source-control";
import type { Env } from "../types";
import { skillRoutes } from "./skills";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  checkRepositoryAccess: vi.fn(),
  resolveCommit: vi.fn(),
  listTree: vi.fn(),
  readBlob: vi.fn(),
}));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: () => ({
    name: "github",
    checkRepositoryAccess: mocks.checkRepositoryAccess,
    resolveCommit: mocks.resolveCommit,
    listTree: mocks.listTree,
    readBlob: mocks.readBlob,
  }),
}));

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "f".repeat(40);
const PROMPT_LIBRARY: Principal = {
  kind: "service",
  service: "prompt-library",
  actor: {
    provider: "microsoft",
    providerUserId: "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    canonicalUserId: "user-1",
    participantUserId: "microsoft:4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  },
};
const PERSON: Principal = { kind: "user", userId: "user-1" };

/** The acting person's role grants; admission queries are the only rows. */
function database(permissions: readonly PermissionId[]): SqlDatabase {
  return {
    prepare(sql) {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() =>
          (sql.includes("FROM users u")
            ? {
                user_id: "user-1",
                suspended_at: null,
                role_id: "role-1",
                role_key: null,
                role_name: "Custom",
              }
            : null) as T | null,
        all: async <T>() => ({
          results: (sql.includes("FROM role_permissions")
            ? permissions.map((permission_id) => ({ permission_id }))
            : []) as T[],
          meta: { changes: 0 },
        }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

function createEnv(
  extra: Partial<Env> = {},
  permissions: readonly PermissionId[] = ["skills.read", "skills.manage"]
): Env {
  return {
    DB: database(permissions),
    SCM_PROVIDER: "github",
    SANDBOX_PROVIDER: "modal",
    TEAMS_ENFORCEMENT: "on",
    REPO_SECRETS_ENCRYPTION_KEY: "test-key",
    ...extra,
  } as Env;
}

const app = createControlPlaneApp([skillRoutes], {
  backgroundTasks: () => createTestBackgroundTasks(),
});

function call(
  method: string,
  path: string,
  body?: unknown,
  environment: Env = createEnv()
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`https://test.local${path}`, {
        method,
        headers: { "Content-Type": "application/json", "If-Match": "revision-1" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      environment
    )
  );
}

function provenance(repoOwner: string, repoName: string) {
  return {
    provider: "github",
    repoOwner,
    repoName,
    requestedRef: SHA,
    resolvedRef: SHA,
    commitSha: SHA,
    subdirectory: "skills/pit-deploy",
    sourceSha256: "b".repeat(64),
    importedAt: 1,
    revisionId: "revision-1",
  };
}

function storedSkill(source: ReturnType<typeof provenance> | null) {
  return skillSchema.parse({
    id: "skill-1",
    name: "pit-deploy",
    description: "Deploy a service",
    body: "# Deploy",
    metadata: {},
    files: [],
    license: null,
    compatibility: null,
    enabled: true,
    currentRevisionId: "revision-1",
    revisionNumber: 1,
    revisionSha256: "c".repeat(64),
    revisionCreatedBy: "user-1",
    creatorDisplayName: null,
    lastEditorDisplayName: null,
    revisionAuthorDisplayName: null,
    assignments: [{ id: "assignment-1", type: "global" }],
    source,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
  });
}

const fromPromptLibrary = storedSkill(provenance("ProvidenceIT", "prompt-library"));
const importSource = (repoOwner = "ProvidenceIT", repoName = "prompt-library", ref = SHA) => ({
  repository: { repoOwner, repoName },
  ref,
  subdirectory: "skills/pit-deploy",
});

async function confirmationFor(previewBody: unknown) {
  const preview = skillImportPreviewResponseSchema.parse(previewBody);
  return {
    expectedCommitSha: preview.source.commitSha,
    expectedSourceSha256: preview.source.sourceSha256,
    expectedRevisionSha256: preview.revisionSha256,
  };
}

const CONFIRMATION = {
  expectedCommitSha: SHA,
  expectedSourceSha256: "b".repeat(64),
  expectedRevisionSha256: "c".repeat(64),
};

/** A confirmation carries the preview's digests; a preview takes none. */
function bodyFor(path: string, fields: Record<string, unknown>) {
  return path.endsWith("/preview") ? fields : { ...fields, ...CONFIRMATION };
}

function expectNoSourceRead() {
  expect(mocks.resolveCommit).not.toHaveBeenCalled();
  expect(mocks.listTree).not.toHaveBeenCalled();
  expect(mocks.readBlob).not.toHaveBeenCalled();
}

function expectNoWrite() {
  expect(SkillStore.prototype.create).not.toHaveBeenCalled();
  expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
  expect(SkillStore.prototype.setEnabled).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: PROMPT_LIBRARY,
    request,
  }));
  mocks.checkRepositoryAccess.mockImplementation(
    async ({ owner, name }: { owner: string; name: string }) => ({
      repoId: 123,
      repoOwner: owner,
      repoName: name,
      defaultBranch: "main",
    })
  );
  mocks.resolveCommit.mockResolvedValue({ sha: SHA });
  mocks.listTree.mockResolvedValue({
    entries: [
      {
        path: "skills/pit-deploy/SKILL.md",
        type: "file",
        blobId: "blob",
        sizeBytes: 50,
        executable: false,
      },
    ],
    truncated: false,
  });
  mocks.readBlob.mockResolvedValue(
    new TextEncoder().encode(
      "---\nname: pit-deploy\ndescription: Deploy a service\n---\n# Deploy\n"
    )
  );
  vi.spyOn(SkillStore.prototype, "create").mockResolvedValue(fromPromptLibrary);
  vi.spyOn(SkillStore.prototype, "get").mockResolvedValue(fromPromptLibrary);
  vi.spyOn(SkillStore.prototype, "setEnabled").mockResolvedValue(fromPromptLibrary);
  vi.spyOn(SkillStore.prototype, "applyImportedRevision").mockResolvedValue({
    skill: fromPromptLibrary,
    revisionCreated: true,
  });
  vi.spyOn(SkillStore.prototype, "nameAvailable").mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("prompt-library imports", () => {
  it("previews and imports an allowlisted repository at a commit, assigned global", async () => {
    const preview = await call("POST", "/skills/import/preview", {
      source: importSource(),
      name: "pit-deploy",
    });
    expect(preview.status).toBe(200);

    const imported = await call("POST", "/skills/import", {
      source: importSource(),
      name: "pit-deploy",
      assignments: [{ type: "global" }],
      ...(await confirmationFor(await preview.json())),
    });

    expect(imported.status).toBe(201);
    expect(SkillStore.prototype.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pit-deploy", assignments: [{ type: "global" }] }),
      "user-1",
      expect.objectContaining({
        repoOwner: "providenceit",
        repoName: "prompt-library",
        commitSha: SHA,
      })
    );
  });

  it("reads the allowlist from PROMPT_LIBRARY_SKILL_REPOSITORIES", async () => {
    const environment = createEnv({ PROMPT_LIBRARY_SKILL_REPOSITORIES: "acme/skills" });

    expect(
      (
        await call(
          "POST",
          "/skills/import/preview",
          { source: importSource("Acme", "Skills") },
          environment
        )
      ).status
    ).toBe(200);
    expect(
      (await call("POST", "/skills/import/preview", { source: importSource() }, environment)).status
    ).toBe(403);
  });

  it.each(["/skills/import/preview", "/skills/import"])(
    "refuses a repository outside the allowlist at %s before reading it",
    async (path) => {
      const response = await call(
        "POST",
        path,
        bodyFor(path, { source: importSource("acme", "skills") })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "The prompt-library service may not manage skills from acme/skills",
        code: "prompt_library_source_not_allowed",
      });
      expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
      expectNoSourceRead();
      expectNoWrite();
    }
  );

  it.each([
    ["/skills/import/preview", "main"],
    ["/skills/import/preview", "v0.1.0"],
    ["/skills/import/preview", SHA.slice(0, 7)],
    ["/skills/import", "main"],
  ])("refuses %s at ref %s", async (path, ref) => {
    const response = await call(
      "POST",
      path,
      bodyFor(path, { source: importSource(undefined, undefined, ref) })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "prompt_library_ref_not_pinned" });
    expectNoSourceRead();
    expectNoWrite();
  });

  it("refuses a SHA-shaped ref that resolves to another commit", async () => {
    mocks.resolveCommit.mockResolvedValue({ sha: OTHER_SHA });

    const response = await call("POST", "/skills/import/preview", { source: importSource() });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "prompt_library_ref_not_pinned" });
  });
});

describe("prompt-library re-imports", () => {
  it("re-imports a skill recorded from the prompt library at a commit", async () => {
    const preview = await call("POST", "/skills/skill-1/reimport/preview", { ref: SHA });
    expect(preview.status).toBe(200);

    const reimported = await call("POST", "/skills/skill-1/reimport", {
      ref: SHA,
      ...(await confirmationFor(await preview.json())),
    });

    expect(reimported.status).toBe(200);
    expect(SkillStore.prototype.applyImportedRevision).toHaveBeenCalledOnce();
  });

  it.each(["/skills/skill-1/reimport/preview", "/skills/skill-1/reimport"])(
    "refuses %s for a skill imported elsewhere or written by hand",
    async (path) => {
      for (const source of [provenance("acme", "skills"), null]) {
        vi.mocked(SkillStore.prototype.get).mockResolvedValue(storedSkill(source));
        const response = await call("POST", path, bodyFor(path, { ref: SHA }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: "prompt_library_source_not_allowed",
        });
      }
      expectNoSourceRead();
      expectNoWrite();
    }
  );

  it.each([
    ["/skills/skill-1/reimport/preview", undefined],
    ["/skills/skill-1/reimport/preview", "main"],
    ["/skills/skill-1/reimport", null],
    ["/skills/skill-1/reimport", "v0.2.0"],
  ])("refuses %s without a commit SHA ref (%s)", async (path, ref) => {
    const response = await call("POST", path, bodyFor(path, ref === undefined ? {} : { ref }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "prompt_library_ref_not_pinned" });
    expectNoSourceRead();
    expectNoWrite();
  });

  it.each(["/skills/skill-1/reimport/preview", "/skills/skill-1/reimport"])(
    "keeps a missing skill at 404 on %s",
    async (path) => {
      vi.mocked(SkillStore.prototype.get).mockResolvedValue(null);

      const response = await call("POST", path, bodyFor(path, { ref: "main" }));

      expect(response.status).toBe(404);
    }
  );
});

describe("prompt-library enable and disable", () => {
  it("toggles a skill recorded from the prompt library", async () => {
    const response = await call("PATCH", "/skills/skill-1", { enabled: false });

    expect(response.status).toBe(200);
    expect(SkillStore.prototype.setEnabled).toHaveBeenCalledWith(
      "skill-1",
      { enabled: false },
      "user-1"
    );
  });

  it("refuses a skill imported elsewhere or written by hand", async () => {
    for (const source of [provenance("acme", "skills"), null]) {
      vi.mocked(SkillStore.prototype.get).mockResolvedValue(storedSkill(source));
      const response = await call("PATCH", "/skills/skill-1", { enabled: false });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "prompt_library_source_not_allowed",
      });
    }
    expect(SkillStore.prototype.setEnabled).not.toHaveBeenCalled();
  });

  it("keeps a missing skill at 404", async () => {
    vi.mocked(SkillStore.prototype.get).mockResolvedValue(null);

    expect((await call("PATCH", "/skills/skill-1", { enabled: true })).status).toBe(404);
    expect(SkillStore.prototype.setEnabled).not.toHaveBeenCalled();
  });
});

describe("prompt-library acting person's grants", () => {
  it("is refused where the acting person lacks skills.manage", async () => {
    const response = await call(
      "PATCH",
      "/skills/skill-1",
      { enabled: false },
      createEnv({}, ["skills.read"])
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "skills.manage",
    });
    expect(SkillStore.prototype.setEnabled).not.toHaveBeenCalled();
  });
});

describe("people are not restricted to the prompt library", () => {
  beforeEach(() => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: PERSON,
      request,
    }));
  });

  it("imports from any repository at a branch", async () => {
    const source = importSource("acme", "skills", "main");
    const preview = await call("POST", "/skills/import/preview", { source });
    expect(preview.status).toBe(200);

    const imported = await call("POST", "/skills/import", {
      source,
      ...(await confirmationFor(await preview.json())),
    });

    expect(imported.status).toBe(201);
  });

  it("re-imports at the recorded ref and toggles a hand-written skill", async () => {
    vi.mocked(SkillStore.prototype.get).mockResolvedValue(
      storedSkill(provenance("acme", "skills"))
    );
    expect((await call("POST", "/skills/skill-1/reimport/preview", {})).status).toBe(200);

    vi.mocked(SkillStore.prototype.get).mockResolvedValue(storedSkill(null));
    expect((await call("PATCH", "/skills/skill-1", { enabled: false })).status).toBe(200);
    // A person's PATCH writes directly; only the service loads the skill first.
    expect(SkillStore.prototype.get).toHaveBeenCalledTimes(1);
  });
});
