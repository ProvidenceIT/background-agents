/**
 * Per-repository protected-path policy: the extra globs that hold agent PRs
 * on top of the shared DEFAULT_PROTECTED_PATHS (which always apply).
 */

import { Hono } from "hono";
import {
  DEFAULT_PROTECTED_PATHS,
  repoPathPolicyInputSchema,
  type RepoPathPolicy,
} from "@open-inspect/shared/policy/protected-paths";
import { RepoPathPolicyStore } from "../db/repo-path-policies";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { repositoryParams } from "./repository-params";
import {
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

function policyResponse(owner: string, name: string, policy: RepoPathPolicy | null): Response {
  return json({
    repo: `${owner.toLowerCase()}/${name.toLowerCase()}`,
    defaults: DEFAULT_PROTECTED_PATHS,
    globs: policy?.globs ?? [],
    updatedBy: policy?.updatedBy ?? null,
    updatedAt: policy?.updatedAt ?? null,
  });
}

async function handleGetPathPolicy(
  _request: Request,
  _env: Env,
  params: { owner: string; name: string },
  ctx: UserRouteContext
): Promise<Response> {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const policy = await new RepoPathPolicyStore(ctx.db).get(repository.owner, repository.name);
  return policyResponse(repository.owner, repository.name, policy);
}

async function handlePutPathPolicy(
  request: Request,
  _env: Env,
  params: { owner: string; name: string },
  ctx: UserRouteContext
): Promise<Response> {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const body = await parseBody(request, repoPathPolicyInputSchema);
  if (body instanceof Response) return body;
  const policy = await new RepoPathPolicyStore(ctx.db).put(
    repository.owner,
    repository.name,
    body.globs,
    ctx.principal.userId,
    Date.now()
  );
  return policyResponse(repository.owner, repository.name, policy);
}

export const repoPathPolicyRoutes = new Hono<ControlPlaneHonoEnv>();

repoPathPolicyRoutes.get(
  "/repos/:owner/:name/path-policy",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    cacheControl: "private, no-store",
    authorization: requirePermission("repositories.read"),
  }),
  (c) => dispatch(c, handleGetPathPolicy)
);
repoPathPolicyRoutes.put(
  "/repos/:owner/:name/path-policy",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("repositories.path_policy.manage"),
  }),
  (c) => dispatch(c, handlePutPathPolicy)
);
