/**
 * Repository ownership: owner team, tier, class, domain and dependencies on
 * `repo_metadata`, with the CODEOWNERS rules the daily sync mirrors
 * (repos/codeowners-sync.ts). Reading is for anyone who can read repositories;
 * changing it takes `repositories.ownership.manage` (Owners and
 * Administrators). The `repo_context` session tool gives the agent the same
 * record for its session's repository.
 */

import { Hono } from "hono";
import {
  codeownersHandles,
  defaultCodeowners,
  effectiveRepoClass,
  repoOwnershipInputSchema,
  type RepoOwnership,
} from "@open-inspect/shared/types/repo-ownership";
import { RepoMetadataStore } from "../db/repo-metadata";
import { TeamStore } from "../db/teams";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { repositoryParams } from "./repository-params";
import { admitTool, refuse } from "./session-tools";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  error,
  json,
  requirePermission,
  type SandboxRouteContext,
} from "./shared";

/** What a repository without a repo_metadata row reads as: unowned and a client repository. */
function unownedRepository(owner: string, name: string): RepoOwnership {
  return {
    repo: `${owner.toLowerCase()}/${name.toLowerCase()}`,
    ownerTeam: null,
    tier: null,
    repoClass: null,
    effectiveRepoClass: effectiveRepoClass(null),
    domain: null,
    dependsOn: null,
    codeowners: null,
    codeownersSyncedAt: null,
  };
}

async function listOwnership(_request: Request, _env: Env, _params: object, ctx: RequestContext) {
  return json({ repos: await new RepoMetadataStore(ctx.db).listOwnership() });
}

async function getOwnership(
  _request: Request,
  _env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
) {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;
  const ownership = await new RepoMetadataStore(ctx.db).getOwnership(owner, name);
  return json({ ownership: ownership ?? unownedRepository(owner, name) });
}

async function putOwnership(
  request: Request,
  _env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
) {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;
  const input = await parseBody(request, repoOwnershipInputSchema);
  if (input instanceof Response) return input;
  if (input.ownerTeamId !== null && !(await new TeamStore(ctx.db).isActive(input.ownerTeamId))) {
    return error("ownerTeamId: no active team has this id", 400);
  }
  const store = new RepoMetadataStore(ctx.db);
  await store.setOwnership(owner, name, input);
  return json({ ownership: await store.getOwnership(owner, name) });
}

/** The agent's view: the effective class only, and owners as handles, never the full rules. */
function repoContextView(ownership: RepoOwnership) {
  const rules = ownership.codeowners ?? [];
  return {
    repo: ownership.repo,
    ownerTeam: ownership.ownerTeam
      ? { slug: ownership.ownerTeam.slug, name: ownership.ownerTeam.name }
      : null,
    tier: ownership.tier,
    repoClass: ownership.effectiveRepoClass,
    classified: ownership.repoClass !== null,
    domain: ownership.domain,
    dependsOn: ownership.dependsOn ?? [],
    codeowners: {
      defaultOwners: defaultCodeowners(rules).map((owner) => owner.handle),
      owners: codeownersHandles(rules),
      syncedAt:
        ownership.codeownersSyncedAt === null
          ? null
          : new Date(ownership.codeownersSyncedAt).toISOString(),
    },
  };
}

export async function handleRepoContext(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const session = await admitTool(env, ctx, params.id, "repo_context");
  if (session instanceof Response) return session;
  if (!session.repoOwner || !session.repoName) {
    return refuse(409, "no_repository", "This session has no repository. Do not retry.");
  }
  const ownership = await new RepoMetadataStore(ctx.db).getOwnership(
    session.repoOwner,
    session.repoName
  );
  return json(repoContextView(ownership ?? unownedRepository(session.repoOwner, session.repoName)));
}

export const repoOwnershipRoutes = new Hono<ControlPlaneHonoEnv>();
const read = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  cacheControl: "private, no-store",
  authorization: requirePermission("repositories.read"),
});
const manage = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  cacheControl: "private, no-store",
  authorization: requirePermission("repositories.ownership.manage"),
});
const sandbox = admit({
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "private, no-store",
});

repoOwnershipRoutes.get("/repo-ownership", read, (c) => dispatch(c, listOwnership));
repoOwnershipRoutes.get("/repos/:owner/:name/ownership", read, (c) => dispatch(c, getOwnership));
repoOwnershipRoutes.put("/repos/:owner/:name/ownership", manage, (c) => dispatch(c, putOwnership));
repoOwnershipRoutes.get("/sessions/:id/repo-context", sandbox, (c) =>
  dispatch(c, handleRepoContext)
);
