/**
 * PR lifecycle tracking on the webhook path (design §5.2). Piggybacks the
 * normalized `/internal/github-event` forward: a `pull_request` event updates
 * the D1 authority record and pushes the fresh snapshot into the owning
 * session DO's artifact mirror. Additive and independent — a failure here
 * never affects automation matching.
 *
 * Correlation is identity-first: `(repository_external_id, pr_number)` via
 * the store's single identity boundary. Branch-name derivation is a guarded
 * fallback only (Superset cross-fork lesson): the derived session must exist
 * AND already be associated with the event's repository, the session must
 * hold a matching DO `pr` artifact, and cross-repository (fork) heads are
 * dropped as not-ours.
 */

import { extractSessionIdFromBranch } from "@open-inspect/shared/git";
import {
  DEFAULT_PROTECTED_PATHS,
  matchProtectedPaths,
  type ProtectedPathMatch,
} from "@open-inspect/shared/policy/protected-paths";
import { prArtifactBelongsToRepo } from "@open-inspect/shared/types/repositories";
import type {
  GitHubAutomationEvent,
  GitHubPullRequestEventFacts,
} from "@open-inspect/shared/triggers";
import type { PullRequestStatus, SessionArtifact } from "@open-inspect/shared/types/artifacts";
import type { RepoPathPolicyStore } from "../db/repo-path-policies";
import type {
  SessionPullRequestRecord,
  SessionPullRequestStore,
} from "../db/session-pull-request-store";
import { snapshotToRecord } from "../session/pull-request-snapshot";
import type { PullRequestSnapshot } from "../source-control";

/** A DO artifact as served by GET /internal/artifacts (metadata pre-parsed). */
export type SessionArtifactSummary = Pick<SessionArtifact, "id" | "type" | "url" | "metadata">;

/** The slice of session-index state the processor needs. */
interface PullRequestLifecycleSessions {
  /** Primary-repo identity for the legacy identity-less-artifact convention. */
  get(id: string): Promise<{ repoOwner: string | null; repoName: string | null } | null>;
  isRepositoryAssociated(sessionId: string, repoOwner: string, repoName: string): Promise<boolean>;
}

export interface PullRequestLifecycleDeps {
  store: Pick<SessionPullRequestStore, "getByIdentity" | "upsert">;
  sessions: PullRequestLifecycleSessions;
  listSessionArtifacts: (sessionId: string) => Promise<SessionArtifactSummary[]>;
  pushSnapshotToSession: (
    sessionId: string,
    artifactId: string,
    snapshot: PullRequestSnapshot
  ) => Promise<void>;
  now: () => number;
}

export type PullRequestLifecycleOutcome =
  | "not_pull_request"
  | "cross_repository"
  | "no_state"
  | "updated"
  | "stale"
  | "record_write_failed"
  | "no_branch_session"
  | "session_not_associated"
  | "no_matching_artifact"
  | "insufficient_payload"
  | "inserted";

/**
 * Lifecycle/draft from webhook facts. Null when the payload carried no state
 * — the event is skipped and read-through repairs later. The `merged` flag
 * disambiguates merged from closed; draft is only meaningful while open.
 */
function deriveStatusFromFacts(facts: GitHubPullRequestEventFacts): PullRequestStatus | null {
  if (!facts.state) return null;
  if (facts.state === "closed") {
    return { lifecycleState: facts.merged === true ? "merged" : "closed", isDraft: false };
  }
  return { lifecycleState: "open", isDraft: facts.draft === true };
}

function repoIdentityFromMetadata(
  metadata: Record<string, unknown> | null
): { repoOwner: string; repoName: string } | null {
  if (!metadata) return null;
  const { repoOwner, repoName } = metadata;
  return typeof repoOwner === "string" && typeof repoName === "string"
    ? { repoOwner, repoName }
    : null;
}

function equalsIgnoreCase(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * The single authority-then-mirror sequence: upsert the D1 record, and only
 * when the monotonic guard accepted the write push the snapshot into the DO
 * mirror. A rejected write is "stale" and must never reach the mirror — the
 * authority record already holds a newer provider state. A *thrown* upsert
 * is different: D1 is best-effort on every freshness path, so the mirror
 * (which applies its own monotonic guard) still gets the snapshot and the
 * outcome reports the record failure; redelivery or read-through repairs D1.
 */
async function upsertRecordThenMirror(
  deps: PullRequestLifecycleDeps,
  snapshot: PullRequestSnapshot,
  identity: { artifactId: string; sessionId: string; createdAt: number; updatedAt: number },
  outcome: "updated" | "inserted"
): Promise<PullRequestLifecycleOutcome> {
  let recordWriteFailed = false;
  try {
    const { applied } = await deps.store.upsert(snapshotToRecord(snapshot, identity));
    if (!applied) return "stale";
  } catch {
    recordWriteFailed = true;
  }

  await deps.pushSnapshotToSession(identity.sessionId, identity.artifactId, snapshot);
  return recordWriteFailed ? "record_write_failed" : outcome;
}

export async function processPullRequestLifecycleEvent(
  deps: PullRequestLifecycleDeps,
  event: GitHubAutomationEvent
): Promise<PullRequestLifecycleOutcome> {
  const facts = event.pullRequest;
  if (!facts) return "not_pull_request";
  // Agents push branches to the base repo (single-App model), so a fork
  // head is never an agent PR — even if the record lookup would match.
  if (facts.isCrossRepository === true) return "cross_repository";

  const status = deriveStatusFromFacts(facts);
  if (!status) return "no_state";

  const record = await deps.store.getByIdentity({
    repositoryExternalId: facts.repositoryExternalId,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    prNumber: facts.number,
  });

  if (record) {
    return applyToRecord(deps, event, facts, status, record);
  }
  return insertViaBranchFallback(deps, event, facts, status);
}

/** Hit path: guarded update of the existing record, then mirror to the DO. */
async function applyToRecord(
  deps: PullRequestLifecycleDeps,
  event: GitHubAutomationEvent,
  facts: GitHubPullRequestEventFacts,
  status: PullRequestStatus,
  record: SessionPullRequestRecord
): Promise<PullRequestLifecycleOutcome> {
  const snapshot: PullRequestSnapshot = {
    number: facts.number,
    url: facts.url ?? record.url,
    lifecycleState: status.lifecycleState,
    isDraft: status.isDraft,
    headBranch: event.branch ?? record.headBranch,
    baseBranch: event.targetBranch ?? record.baseBranch,
    headSha: facts.headSha ?? record.headSha ?? undefined,
    // The webhook carries the repository's current canonical location —
    // refreshes stored owner/name after a rename/transfer.
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    repositoryExternalId: facts.repositoryExternalId ?? record.repositoryExternalId ?? undefined,
    providerCreatedAt: facts.providerCreatedAt ?? record.providerCreatedAt ?? undefined,
    providerUpdatedAt: facts.providerUpdatedAt ?? record.providerUpdatedAt ?? undefined,
    // Record fallback covers payloads missing the field; snapshotToRecord
    // clears both when the state no longer carries them (e.g. reopen).
    mergedAt: facts.mergedAt ?? record.mergedAt ?? undefined,
    closedAt: facts.closedAt ?? record.closedAt ?? undefined,
  };

  return upsertRecordThenMirror(
    deps,
    snapshot,
    {
      artifactId: record.artifactId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: deps.now(),
    },
    "updated"
  );
}

/**
 * Miss path: derive the session from the branch convention, verify the
 * guards, and repair the missing record against the session's own DO `pr`
 * artifact (e.g. when the best-effort creation write failed).
 */
async function insertViaBranchFallback(
  deps: PullRequestLifecycleDeps,
  event: GitHubAutomationEvent,
  facts: GitHubPullRequestEventFacts,
  status: PullRequestStatus
): Promise<PullRequestLifecycleOutcome> {
  const sessionId = event.branch ? extractSessionIdFromBranch(event.branch) : null;
  if (!sessionId) return "no_branch_session";

  const associated = await deps.sessions.isRepositoryAssociated(
    sessionId,
    event.repoOwner,
    event.repoName
  );
  if (!associated) return "session_not_associated";

  const session = await deps.sessions.get(sessionId);
  const isPrimary =
    session !== null &&
    equalsIgnoreCase(session.repoOwner, event.repoOwner) &&
    equalsIgnoreCase(session.repoName, event.repoName);

  const candidates = (await deps.listSessionArtifacts(sessionId)).filter(
    (candidate) =>
      candidate.type === "pr" &&
      prArtifactBelongsToRepo(
        repoIdentityFromMetadata(candidate.metadata),
        { repoOwner: event.repoOwner, repoName: event.repoName },
        isPrimary
      )
  );
  // The record mirrors one specific artifact: prefer the artifact carrying
  // the webhook's PR number (a session can hold several PRs in one repo);
  // number-less legacy metadata is acceptable only when no numbered
  // artifact matches.
  const artifact =
    candidates.find((candidate) => candidate.metadata?.number === facts.number) ??
    candidates.find((candidate) => typeof candidate.metadata?.number !== "number");
  if (!artifact) return "no_matching_artifact";

  const url = facts.url ?? artifact.url;
  if (!url || !event.branch || !event.targetBranch) return "insufficient_payload";

  const now = deps.now();
  const snapshot: PullRequestSnapshot = {
    number: facts.number,
    url,
    lifecycleState: status.lifecycleState,
    isDraft: status.isDraft,
    headBranch: event.branch,
    baseBranch: event.targetBranch,
    headSha: facts.headSha,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    repositoryExternalId: facts.repositoryExternalId,
    providerCreatedAt: facts.providerCreatedAt,
    providerUpdatedAt: facts.providerUpdatedAt,
    mergedAt: facts.mergedAt,
    closedAt: facts.closedAt,
  };

  return upsertRecordThenMirror(
    deps,
    snapshot,
    { artifactId: artifact.id, sessionId, createdAt: now, updatedAt: now },
    "inserted"
  );
}

// ─── Protected-path hold ──────────────────────────────────────────────────────

export const PROTECTED_PATH_HOLD_LABEL = "sf:hold-protected-path";

/** Events that can change a PR's diff; each is checked at its head SHA. */
const PATH_CHECK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.reopened",
]);

/** The PR a GitHub write targets; repositoryId scopes the installation token. */
export interface HoldPullRequestRef {
  repositoryId: number;
  repoOwner: string;
  repoName: string;
  number: number;
}

/** App-authenticated GitHub operations the hold step needs. */
export interface ProtectedPathHoldGitHub {
  listChangedFiles(pr: HoldPullRequestRef): Promise<string[]>;
  addLabel(pr: HoldPullRequestRef, label: string): Promise<void>;
  removeLabel(pr: HoldPullRequestRef, label: string): Promise<void>;
  comment(pr: HoldPullRequestRef, body: string): Promise<void>;
}

export interface ProtectedPathHoldDeps {
  store: Pick<SessionPullRequestStore, "getByIdentity" | "getPathCheck" | "recordPathCheck">;
  policies: Pick<RepoPathPolicyStore, "get">;
  github: ProtectedPathHoldGitHub;
}

export type ProtectedPathHoldOutcome =
  "not_checked_event" | "no_head_sha" | "not_session_pr" | "stale" | "held" | "clear";

function formatHoldComment(headSha: string, matches: ProtectedPathMatch[]): string {
  const categories = [...new Set(matches.map((match) => match.category))];
  const lines = matches.map((match) => `- \`${match.path}\` (${match.category})`);
  return [
    `**Held for human review:** this pull request changes protected paths (${categories.join(", ")}) at ${headSha.slice(0, 12)}.`,
    "",
    ...lines,
    "",
    `The \`${PROTECTED_PATH_HOLD_LABEL}\` label stays until a push removes these changes; it is never merged automatically.`,
  ].join("\n");
}

/**
 * Check a session PR's changed files against the protected globs and record
 * the result at the event's head SHA. Runs after lifecycle tracking, so the
 * record's head is already current. D1 is written first (it is what the merge
 * gate reads); the label and comment are the human-visible mirror. Non-session
 * PRs have no record and are ignored.
 *
 * The files list is the PR's current diff, which can be newer than the event's
 * SHA under a fast push; the check for that newer head then overwrites it.
 */
export async function processProtectedPathHold(
  deps: ProtectedPathHoldDeps,
  event: GitHubAutomationEvent
): Promise<ProtectedPathHoldOutcome> {
  const facts = event.pullRequest;
  if (!facts || facts.isCrossRepository === true || !PATH_CHECK_EVENT_TYPES.has(event.eventType)) {
    return "not_checked_event";
  }
  const headSha = facts.headSha;
  if (!headSha) return "no_head_sha";

  const record = await deps.store.getByIdentity({
    repositoryExternalId: facts.repositoryExternalId,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    prNumber: facts.number,
  });
  if (!record) return "not_session_pr";

  const pr: HoldPullRequestRef = {
    repositoryId: event.repositoryId,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    number: facts.number,
  };
  const [previous, files, policy] = await Promise.all([
    deps.store.getPathCheck(record.artifactId),
    deps.github.listChangedFiles(pr),
    deps.policies.get(event.repoOwner, event.repoName),
  ]);
  const matches = matchProtectedPaths(files, [
    ...DEFAULT_PROTECTED_PATHS,
    ...(policy?.globs ?? []),
  ]);
  const held = matches.length > 0;

  const recorded = await deps.store.recordPathCheck(
    record.artifactId,
    headSha,
    held ? matches : null
  );
  if (!recorded) return "stale";

  if (held) {
    await deps.github.addLabel(pr, PROTECTED_PATH_HOLD_LABEL);
    // One comment per distinct match set, not per push.
    if (JSON.stringify(previous?.matches ?? null) !== JSON.stringify(matches)) {
      await deps.github.comment(pr, formatHoldComment(headSha, matches));
    }
    return "held";
  }
  if (previous?.matches) await deps.github.removeLabel(pr, PROTECTED_PATH_HOLD_LABEL);
  return "clear";
}
