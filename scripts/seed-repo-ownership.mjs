#!/usr/bin/env node
/**
 * Seeds owner team, tier and class for the three factory pilots through the
 * web app's own API (`PUT /api/repos/:owner/:name/ownership`), so the same
 * permission check, validation and audit apply as in Settings. Dry-run is the
 * default: it prints what each repository has and what it would get, and
 * writes nothing. Pass --execute to apply. Re-running a completed seed is a
 * no-op, since unchanged repositories are skipped.
 *
 * Usage:
 *   OI_WEB_URL=https://oi.example OI_COOKIE=<session token> \
 *     node scripts/seed-repo-ownership.mjs [--execute]
 *
 * OI_COOKIE is the value of the `__Secure-openinspect.session_token` cookie of
 * a signed-in Owner or Administrator (it is never printed). Pass
 * OI_COOKIE_NAME=openinspect.session_token for a deployment served over plain
 * http. The owner team must already exist (slug `platform`).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_TEAM_SLUG = "platform";

/** The pilots and their seed values; domain and dependencies are left for Settings. */
export const PILOTS = [
  { repo: "ProvidenceIT/software-factory-playground", tier: "T3", repoClass: "playground" },
  { repo: "ProvidenceIT/prompt-library", tier: "T2", repoClass: "internal" },
  { repo: "ProvidenceIT/background-agents", tier: "T1", repoClass: "internal" },
];

/** The PUT body for one pilot, keeping whatever domain and dependencies it already has. */
export function seedBody(pilot, teamId, current) {
  return {
    ownerTeamId: teamId,
    tier: pilot.tier,
    repoClass: pilot.repoClass,
    domain: current?.domain ?? null,
    dependsOn: current?.dependsOn ?? null,
  };
}

/** Whether `current` (a RepoOwnership, or null) already carries the seed. */
export function isSeeded(current, body) {
  return (
    current !== null &&
    (current.ownerTeam?.id ?? null) === body.ownerTeamId &&
    current.tier === body.tier &&
    current.repoClass === body.repoClass
  );
}

function describe(ownership) {
  if (!ownership) return "nothing";
  return `team=${ownership.ownerTeam?.slug ?? "-"} tier=${ownership.tier ?? "-"} class=${ownership.repoClass ?? "-"}`;
}

/**
 * Runs the seed against `api(method, path, body)`, which answers `{ status, body }`.
 * Returns one line per pilot; throws on the first failed request.
 */
export async function seedRepoOwnership(api, { execute }) {
  const teams = await api("GET", "/api/teams");
  if (teams.status !== 200) throw new Error(`GET /api/teams answered ${teams.status}`);
  const team = (teams.body.teams ?? []).find(
    (candidate) => candidate.slug === OWNER_TEAM_SLUG && candidate.archivedAt === null
  );
  if (!team) throw new Error(`No active team with slug "${OWNER_TEAM_SLUG}"; create it first`);

  const lines = [];
  for (const pilot of PILOTS) {
    const [owner, name] = pilot.repo.split("/");
    const path = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/ownership`;
    const got = await api("GET", path);
    if (got.status !== 200) throw new Error(`GET ${path} answered ${got.status}`);
    const current = got.body.ownership;
    const body = seedBody(pilot, team.id, current);
    if (isSeeded(current, body)) {
      lines.push(`${pilot.repo}: already seeded (${describe(current)})`);
      continue;
    }
    const target = `team=${OWNER_TEAM_SLUG} tier=${body.tier} class=${body.repoClass}`;
    if (!execute) {
      lines.push(`${pilot.repo}: would change ${describe(current)} -> ${target}`);
      continue;
    }
    const put = await api("PUT", path, body);
    if (put.status !== 200) {
      throw new Error(`PUT ${path} answered ${put.status}: ${JSON.stringify(put.body)}`);
    }
    lines.push(`${pilot.repo}: seeded ${target}`);
  }
  return lines;
}

function webApi(baseUrl, cookieName, cookie) {
  return async (method, path, body) => {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        Cookie: `${cookieName}=${cookie}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: "non-JSON response" };
    }
    return { status: response.status, body: parsed };
  };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const baseUrl = process.env.OI_WEB_URL;
  const cookie = process.env.OI_COOKIE;
  const cookieName = process.env.OI_COOKIE_NAME ?? "__Secure-openinspect.session_token";
  if (!baseUrl || !cookie) {
    console.error("Set OI_WEB_URL and OI_COOKIE (see the header of this script).");
    process.exit(2);
  }
  if (/[;\s]/.test(cookie)) {
    console.error("OI_COOKIE must be the bare cookie value (no name=, no ;).");
    process.exit(2);
  }
  console.log(execute ? "Seeding repository ownership:" : "Dry run (pass --execute to write):");
  for (const line of await seedRepoOwnership(webApi(baseUrl, cookieName, cookie), { execute })) {
    console.log(`  ${line}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
