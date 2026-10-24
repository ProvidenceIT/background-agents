import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
} from "@open-inspect/shared/types/approvals";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { Env } from "../types";

/** What a handler or notifier is given when it runs after the decision is stored. */
export interface ApprovalEffectDeps {
  env: Env;
  db: SqlDatabase;
  log: Logger;
}

export interface ApprovalDecidedEvent {
  request: ApprovalRequest;
  decision: ApprovalDecision;
}

/**
 * Starts the follow-up for one kind (a session, a step) once a request of that kind is decided.
 * It runs once per request, after the decision is stored; nothing waits for it.
 */
export type ApprovalHandler = (
  event: ApprovalDecidedEvent,
  deps: ApprovalEffectDeps
) => Promise<void>;

/** Tells people about requests: Teams cards implement this. */
export interface ApprovalNotifier {
  readonly name: string;
  onCreated(request: ApprovalRequest, deps: ApprovalEffectDeps): Promise<void>;
  /** Fires for every decision, whatever surface it was made on. */
  onDecided(event: ApprovalDecidedEvent, deps: ApprovalEffectDeps): Promise<void>;
}

/** One handler per kind and any number of notifiers. */
export class ApprovalRegistry {
  private readonly handlers = new Map<ApprovalKind, ApprovalHandler>();
  private readonly registeredNotifiers: ApprovalNotifier[] = [];

  registerHandler(kind: ApprovalKind, onDecided: ApprovalHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Approval handler already registered: ${kind}`);
    this.handlers.set(kind, onDecided);
  }

  registerNotifier(notifier: ApprovalNotifier): void {
    this.registeredNotifiers.push(notifier);
  }

  handler(kind: ApprovalKind): ApprovalHandler | undefined {
    return this.handlers.get(kind);
  }

  get notifiers(): readonly ApprovalNotifier[] {
    return this.registeredNotifiers;
  }
}

/** The process-wide registry the routes use; each kind's module registers itself here. */
export const approvalRegistry = new ApprovalRegistry();

export function registerApprovalHandler(kind: ApprovalKind, onDecided: ApprovalHandler): void {
  approvalRegistry.registerHandler(kind, onDecided);
}

export function registerApprovalNotifier(notifier: ApprovalNotifier): void {
  approvalRegistry.registerNotifier(notifier);
}
