import assert from "node:assert/strict";
import { test } from "node:test";
import { PILOTS, seedRepoOwnership } from "./seed-repo-ownership.mjs";

const PLATFORM = { id: "team-platform", slug: "platform", name: "Platform", archivedAt: null };

/** A web API holding ownership per path; records every write. */
function fakeApi(initial = {}) {
  const state = { ...initial };
  const writes = [];
  const api = async (method, path, body) => {
    if (path === "/api/teams") return { status: 200, body: { teams: [PLATFORM] } };
    if (method === "GET") {
      return { status: 200, body: { ownership: state[path] ?? null } };
    }
    writes.push({ path, body });
    state[path] = {
      ownerTeam: { id: body.ownerTeamId, slug: "platform", name: "Platform" },
      tier: body.tier,
      repoClass: body.repoClass,
      domain: body.domain,
      dependsOn: body.dependsOn,
    };
    return { status: 200, body: { ownership: state[path] } };
  };
  return { api, writes };
}

test("dry run reports the planned values and writes nothing", async () => {
  const { api, writes } = fakeApi();
  const lines = await seedRepoOwnership(api, { execute: false });
  assert.deepEqual(lines, [
    "ProvidenceIT/software-factory-playground: would change nothing -> team=platform tier=T3 class=playground",
    "ProvidenceIT/prompt-library: would change nothing -> team=platform tier=T2 class=internal",
    "ProvidenceIT/background-agents: would change nothing -> team=platform tier=T1 class=internal",
  ]);
  assert.deepEqual(writes, []);
});

test("execute seeds the three pilots once and keeps an existing domain", async () => {
  const path = "/api/repos/ProvidenceIT/prompt-library/ownership";
  const { api, writes } = fakeApi({
    [path]: { ownerTeam: null, tier: null, repoClass: null, domain: "prompts", dependsOn: null },
  });
  await seedRepoOwnership(api, { execute: true });
  assert.equal(writes.length, PILOTS.length);
  assert.deepEqual(writes[1], {
    path,
    body: {
      ownerTeamId: "team-platform",
      tier: "T2",
      repoClass: "internal",
      domain: "prompts",
      dependsOn: null,
    },
  });

  const again = await seedRepoOwnership(api, { execute: true });
  assert.equal(writes.length, PILOTS.length);
  assert.equal(
    again[2],
    "ProvidenceIT/background-agents: already seeded (team=platform tier=T1 class=internal)"
  );
});

test("stops when the owner team does not exist", async () => {
  const api = async () => ({ status: 200, body: { teams: [] } });
  await assert.rejects(seedRepoOwnership(api, { execute: true }), /No active team with slug/);
});
