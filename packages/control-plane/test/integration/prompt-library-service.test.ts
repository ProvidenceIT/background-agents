import { beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared/service-auth";
import type { SkillImportSource } from "@open-inspect/shared/types/skills";
import { SkillStore } from "../../src/db/skills";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

/** Entra object ids: the subject a Microsoft web sign-in stores and the sync asserts. */
const ADMIN_OBJECT_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const MEMBER_OBJECT_ID = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const UNKNOWN_OBJECT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BASE = "https://test.local";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const content = {
  description: "Deploy a service",
  body: "# Deploy\n",
  license: null,
  compatibility: null,
  metadata: {},
  frontmatter: {},
  files: [],
};

function importSource(repoOwner: string, repoName: string): SkillImportSource {
  return {
    provider: "github",
    repoOwner,
    repoName,
    requestedRef: SHA,
    resolvedRef: SHA,
    commitSha: SHA,
    subdirectory: "skills/pit-deploy",
    sourceSha256: "b".repeat(64),
  };
}

async function signedFetch(p: {
  service?: ServiceName;
  method: string;
  path: string;
  body?: unknown;
  objectId?: string | null;
}): Promise<Response> {
  const service = p.service ?? "prompt-library";
  const url = `${BASE}${p.path}`;
  const body = p.body === undefined ? undefined : JSON.stringify(p.body);
  const objectId = p.objectId === undefined ? ADMIN_OBJECT_ID : p.objectId;
  const headers = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method: p.method,
    url,
    body,
    actor: objectId ? `microsoft:${objectId}` : undefined,
  });
  return SELF.fetch(url, {
    method: p.method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

/** A person whose Microsoft sign-in enrolled `objectId`, holding a built-in role. */
async function enroll(objectId: string, role: "administrator" | "member"): Promise<string> {
  const users = new UserStore(env.DB);
  const user = await users.createUser({
    displayName: `${role} ${objectId}`,
    email: `${objectId}@corp.test`,
    emailVerified: true,
  });
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind(`role_builtin_${role}`, user.id)
    .run();
  await users.createIdentity({ userId: user.id, provider: "microsoft", providerUserId: objectId });
  return user.id;
}

async function enabled(skillId: string): Promise<boolean | undefined> {
  return (await new SkillStore(env.DB).get(skillId))?.enabled;
}

describe("prompt-library service", () => {
  let adminId: string;
  let synced: string;
  let foreign: string;
  let handWritten: string;

  beforeEach(async () => {
    await cleanD1Tables();
    adminId = await enroll(ADMIN_OBJECT_ID, "administrator");
    await enroll(MEMBER_OBJECT_ID, "member");
    const skills = new SkillStore(env.DB);
    const assignments = [{ type: "global" as const }];
    synced = (
      await skills.create(
        { name: "pit-deploy", content, assignments },
        adminId,
        importSource("ProvidenceIT", "prompt-library")
      )
    ).id;
    foreign = (
      await skills.create(
        { name: "acme-deploy", content, assignments },
        adminId,
        importSource("acme", "skills")
      )
    ).id;
    handWritten = (await skills.create({ name: "hand-written", content, assignments }, adminId)).id;
  });

  it("disables a synced skill as the acting person, audited with the service", async () => {
    const response = await signedFetch({
      method: "PATCH",
      path: `/skills/${synced}`,
      body: { enabled: false },
    });

    expect(response.status).toBe(200);
    await expect(enabled(synced)).resolves.toBe(false);
    await expect(
      env.DB.prepare("SELECT updated_by FROM skills WHERE id = ?").bind(synced).first()
    ).resolves.toEqual({ updated_by: adminId });
    await vi.waitFor(async () => {
      const audit = await env.DB.prepare(
        `SELECT principal_kind, actor_user_id_snapshot, actor_service_snapshot, operation_result
         FROM authorization_audit_events WHERE actor_service_snapshot = 'prompt-library'`
      ).all();
      expect(audit.results).toEqual([
        {
          principal_kind: "service",
          actor_user_id_snapshot: adminId,
          actor_service_snapshot: "prompt-library",
          operation_result: "applied",
        },
      ]);
    });
  });

  it("lists and reads the catalog and previews its resolution", async () => {
    const list = await signedFetch({ method: "GET", path: "/skills" });
    expect(list.status).toBe(200);
    const { skills } = await list.json<{ skills: { id: string }[] }>();
    expect(skills.map((skill) => skill.id).sort()).toEqual([synced, foreign, handWritten].sort());

    expect((await signedFetch({ method: "GET", path: `/skills/${synced}` })).status).toBe(200);
    expect(
      (
        await signedFetch({
          method: "POST",
          path: "/skills/resolve-preview",
          body: { selection: { mode: "all" } },
        })
      ).status
    ).toBe(200);
  });

  it.each([
    ["a skill imported from another repository", () => foreign],
    ["a hand-written skill", () => handWritten],
  ])("refuses to toggle %s", async (_label, skillId) => {
    const response = await signedFetch({
      method: "PATCH",
      path: `/skills/${skillId()}`,
      body: { enabled: false },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "prompt_library_source_not_allowed",
    });
    await expect(enabled(skillId())).resolves.toBe(true);
  });

  it("answers 404 for a skill that does not exist", async () => {
    const response = await signedFetch({
      method: "PATCH",
      path: "/skills/skill_missing",
      body: { enabled: false },
    });

    expect(response.status).toBe(404);
  });

  it("refuses imports and re-imports outside its sources before reading them", async () => {
    const outside = await signedFetch({
      method: "POST",
      path: "/skills/import/preview",
      body: {
        source: { repository: { repoOwner: "acme", repoName: "skills" }, ref: SHA },
      },
    });
    expect(outside.status).toBe(403);
    await expect(outside.json()).resolves.toMatchObject({
      code: "prompt_library_source_not_allowed",
    });

    const branch = await signedFetch({
      method: "POST",
      path: `/skills/${synced}/reimport/preview`,
      body: { ref: "main" },
    });
    expect(branch.status).toBe(403);
    await expect(branch.json()).resolves.toMatchObject({ code: "prompt_library_ref_not_pinned" });

    const elsewhere = await signedFetch({
      method: "POST",
      path: `/skills/${foreign}/reimport/preview`,
      body: { ref: SHA },
    });
    expect(elsewhere.status).toBe(403);
    await expect(elsewhere.json()).resolves.toMatchObject({
      code: "prompt_library_source_not_allowed",
    });
  });

  it("still needs the acting person's own skills.manage grant", async () => {
    const response = await signedFetch({
      method: "PATCH",
      path: `/skills/${synced}`,
      body: { enabled: false },
      objectId: MEMBER_OBJECT_ID,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "skills.manage",
    });
    await expect(enabled(synced)).resolves.toBe(true);
  });

  it("refuses an unknown object id and a missing actor", async () => {
    const unknown = await signedFetch({
      method: "PATCH",
      path: `/skills/${synced}`,
      body: { enabled: false },
      objectId: UNKNOWN_OBJECT_ID,
    });
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toEqual({
      error: "Forbidden",
      code: "service_actor_not_enrolled",
    });

    const actorless = await signedFetch({
      method: "PATCH",
      path: `/skills/${synced}`,
      body: { enabled: false },
      objectId: null,
    });
    expect(actorless.status).toBe(403);
    await expect(actorless.json()).resolves.toEqual({
      error: "Forbidden",
      code: "service_actor_required",
    });
    await expect(enabled(synced)).resolves.toBe(true);
  });

  it.each([
    ["PUT", (id: string) => `/skills/${id}`, { content, assignments: [] }],
    ["DELETE", (id: string) => `/skills/${id}`, undefined],
    ["POST", () => "/skills", { name: "new-skill", content }],
    ["GET", () => "/skill-profiles", undefined],
  ] as const)("refuses %s on a route that does not opt it in", async (method, path, body) => {
    const response = await signedFetch({ method, path: path(synced), body });

    expect(response.status).toBe(403);
    await expect(new SkillStore(env.DB).get(synced)).resolves.toMatchObject({ enabled: true });
  });

  it("keeps every other bot off skill management", async () => {
    for (const service of ["teams-bot", "motion"] as const) {
      const response = await signedFetch({
        service,
        method: "PATCH",
        path: `/skills/${synced}`,
        body: { enabled: false },
      });
      expect(response.status, service).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Forbidden",
        code: "service_capability_required",
      });
    }
    await expect(enabled(synced)).resolves.toBe(true);
  });

  it("leaves people free to toggle any skill", async () => {
    const response = await serviceFetch(`${BASE}/skills/${handWritten}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    await expect(enabled(handWritten)).resolves.toBe(false);
  });
});
