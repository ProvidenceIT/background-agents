import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Skill, SkillImportSource } from "@open-inspect/shared/types/skills";
import { SkillStore } from "../../src/db/skills";
import { buildSkillRevision } from "../../src/skills/content-addressing";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const frontmatter = {
  "disable-model-invocation": true,
  "argument-hint": "[branch]",
  paths: ["src/**"],
  reminder: { every: 3, text: "check the diff" },
};

const content = {
  description: "Opens pull requests",
  body: "# Pull request\n",
  license: null,
  compatibility: null,
  metadata: { "credits.author": "Matt Pocock" },
  frontmatter,
  files: [],
};

const source: SkillImportSource = {
  provider: "github",
  repoOwner: "mattpocock",
  repoName: "skills",
  requestedRef: null,
  resolvedRef: "main",
  commitSha: "a".repeat(40),
  subdirectory: "pr",
  sourceSha256: "b".repeat(64),
};

function skillMarkdown(skill: Skill): string {
  return skill.files.find((file) => file.path === "SKILL.md")!.content;
}

describe("preserved skill frontmatter", () => {
  beforeEach(cleanD1Tables);

  it("stores frontmatter per revision as canonical JSON and renders it into SKILL.md", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await skills.create({ name: "pr", content, assignments: [] }, "user_1", source);

    expect(skill.frontmatter).toEqual(frontmatter);
    const markdown = skillMarkdown(skill);
    expect(markdown.split("\n")[1]).toBe("name: pr");
    expect(markdown).toContain("\ndisable-model-invocation: true\n");
    expect(markdown).toContain('\nreminder: {"every": 3, "text": "check the diff"}\n');
    const row = await env.DB.prepare("SELECT frontmatter_json FROM skill_revisions WHERE id = ?")
      .bind(skill.currentRevisionId)
      .first<{ frontmatter_json: string }>();
    expect(row?.frontmatter_json).toBe(
      '{"argument-hint":"[branch]","disable-model-invocation":true,"paths":["src/**"],"reminder":{"every":3,"text":"check the diff"}}'
    );
  });

  it("reads revisions written before the column existed as empty frontmatter", async () => {
    const legacy = { ...content, frontmatter: {}, metadata: {} };
    const revision = await buildSkillRevision("legacy-skill", legacy);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO skills (id, name, enabled, created_by, updated_by, created_at, updated_at)
         VALUES ('skill_legacy', 'legacy-skill', 1, 'user_1', 'user_1', 1, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO skill_revisions
         (id, skill_id, revision_number, revision_sha256, description, body,
          metadata_json, total_bytes, created_by, created_at)
         VALUES ('rev_legacy', 'skill_legacy', 1, ?, ?, ?, '{}', ?, 'user_1', 1)`
      ).bind(revision.revisionSha256, legacy.description, legacy.body, revision.totalBytes),
      env.DB.prepare(
        "UPDATE skills SET current_revision_id = 'rev_legacy' WHERE id = 'skill_legacy'"
      ),
    ]);

    const skill = await new SkillStore(env.DB).get("skill_legacy");

    expect(skill?.frontmatter).toEqual({});
    expect(skill?.revisionSha256).toBe(revision.revisionSha256);
  });

  it("treats a re-import with the same frontmatter as a no-op and a changed one as a revision", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await skills.create({ name: "pr", content, assignments: [] }, "user_1", source);
    const reordered = {
      ...content,
      frontmatter: {
        reminder: { text: "check the diff", every: 3 },
        paths: ["src/**"],
        "argument-hint": "[branch]",
        "disable-model-invocation": true,
      },
    };

    const unchanged = await skills.applyImportedRevision(
      skill.id,
      reordered,
      { ...source, commitSha: "c".repeat(40) },
      "user_2",
      skill.currentRevisionId
    );
    expect(unchanged?.revisionCreated).toBe(false);

    const changed = await skills.applyImportedRevision(
      skill.id,
      { ...content, frontmatter: { ...frontmatter, "disable-model-invocation": false } },
      { ...source, commitSha: "d".repeat(40) },
      "user_2",
      skill.currentRevisionId
    );
    expect(changed?.revisionCreated).toBe(true);
    expect(changed?.skill.frontmatter["disable-model-invocation"]).toBe(false);
    expect(skillMarkdown(changed!.skill)).toContain("\ndisable-model-invocation: false\n");
  });

  it("accepts frontmatter on create, preview and replace, and rejects denied keys", async () => {
    const created = await serviceFetch("https://test.local/skills", {
      method: "POST",
      body: JSON.stringify({ name: "route-pr", content, assignments: [] }),
    });
    expect(created.status).toBe(201);
    const { skill } = await created.json<{ skill: Skill }>();
    expect(skill.frontmatter).toEqual(frontmatter);

    const read = await serviceFetch(`https://test.local/skills/${skill.id}`);
    await expect(read.json()).resolves.toMatchObject({ skill: { frontmatter } });

    const preview = await serviceFetch("https://test.local/skills/preview", {
      method: "POST",
      body: JSON.stringify({ name: "route-pr", content }),
    });
    expect(preview.status).toBe(200);
    const previewed = await preview.json<{ skillMarkdown: string; revisionSha256: string }>();
    expect(previewed.skillMarkdown).toContain("\ndisable-model-invocation: true\n");
    expect(previewed.revisionSha256).toBe(skill.revisionSha256);

    for (const key of ["allowed-tools", "hooks", "model", "context", "name"]) {
      const denied = await serviceFetch("https://test.local/skills/preview", {
        method: "POST",
        body: JSON.stringify({
          name: "route-pr",
          content: { ...content, frontmatter: { [key]: 1 } },
        }),
      });
      expect(denied.status).toBe(400);
    }

    const replaced = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      headers: { "If-Match": skill.currentRevisionId },
      body: JSON.stringify({
        content: { ...content, frontmatter: { "argument-hint": "[pr]" } },
        assignments: [],
      }),
    });
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      skill: { revisionNumber: 2, frontmatter: { "argument-hint": "[pr]" } },
    });
  });

  it("keeps the current frontmatter when a replace omits the field", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await skills.create({ name: "pr", content, assignments: [] }, "user_1", source);
    const { frontmatter: _omitted, ...withoutFrontmatter } = content;

    const replaced = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      headers: { "If-Match": skill.currentRevisionId },
      body: JSON.stringify({
        content: { ...withoutFrontmatter, description: "Opens pull requests carefully" },
        assignments: [],
      }),
    });

    expect(replaced.status).toBe(200);
    const { skill: updated } = await replaced.json<{ skill: Skill }>();
    expect(updated.revisionNumber).toBe(2);
    expect(updated.frontmatter).toEqual(frontmatter);
    expect(skillMarkdown(updated)).toContain("\ndisable-model-invocation: true\n");

    const cleared = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      headers: { "If-Match": updated.currentRevisionId },
      body: JSON.stringify({ content: { ...content, frontmatter: {} }, assignments: [] }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      skill: { revisionNumber: 3, frontmatter: {} },
    });
  });
});
