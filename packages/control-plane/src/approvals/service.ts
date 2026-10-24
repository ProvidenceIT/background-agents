import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateApprovalRequest,
} from "@open-inspect/shared/types/approvals";
import {
  ApprovalRequestStore,
  type ApprovalAuditActor,
  type ApprovalDecisionInput,
} from "../db/approval-requests";
import type { BackgroundTasks } from "../platform-ports";
import type { ApprovalEffectDeps, ApprovalRegistry } from "./registry";

export type ApprovalDecideResult =
  | { kind: "ok"; request: ApprovalRequest; decision: ApprovalDecision }
  | { kind: "not_found" }
  | { kind: "not_a_responder" }
  | { kind: "invalid_choice" }
  /** Settled already (by another answer, superseded or expired): the current request. */
  | { kind: "conflict"; request: ApprovalRequest };

/**
 * The approval rules every surface shares: responder and choice checks, then the store's
 * compare-and-set, then the follow-up. Only the call that settles a request runs its handler and
 * the notifiers' `onDecided`, so each runs once per request whatever surface answered.
 */
export class ApprovalService {
  private readonly store: ApprovalRequestStore;

  constructor(
    private readonly registry: ApprovalRegistry,
    private readonly backgroundTasks: BackgroundTasks,
    private readonly deps: ApprovalEffectDeps
  ) {
    this.store = new ApprovalRequestStore(deps.db);
  }

  async create(
    input: CreateApprovalRequest & { createdBy: string },
    actor: ApprovalAuditActor
  ): Promise<{ request: ApprovalRequest; created: boolean }> {
    const result = await this.store.create(input, actor);
    if (result.created) {
      for (const notifier of this.registry.notifiers) {
        this.backgroundTasks.submit(() => notifier.onCreated(result.request, this.deps), {
          name: "approval_notify_created",
          context: { notifier: notifier.name, approval_id: result.request.id },
        });
      }
    }
    return result;
  }

  async decide(
    requestId: string,
    input: ApprovalDecisionInput,
    actor: ApprovalAuditActor
  ): Promise<ApprovalDecideResult> {
    const request = await this.store.get(requestId);
    if (!request) return { kind: "not_found" };
    if (!(await this.store.isResponder(request, input.userId))) return { kind: "not_a_responder" };
    if (!request.choices.includes(input.decision)) return { kind: "invalid_choice" };

    const outcome = await this.store.decide(requestId, input, actor);
    if (outcome.kind === "not_found") return outcome;
    if (outcome.kind === "conflict") return outcome;
    if (outcome.kind === "decided") {
      const event = { request: outcome.request, decision: outcome.decision };
      const context = { approval_id: requestId, kind: request.kind };
      const handler = this.registry.handler(request.kind);
      if (handler) {
        this.backgroundTasks.submit(() => handler(event, this.deps), {
          name: "approval_handler",
          context,
        });
      }
      for (const notifier of this.registry.notifiers) {
        this.backgroundTasks.submit(() => notifier.onDecided(event, this.deps), {
          name: "approval_notify_decided",
          context: { ...context, notifier: notifier.name },
        });
      }
    }
    return { kind: "ok", request: outcome.request, decision: outcome.decision };
  }
}
