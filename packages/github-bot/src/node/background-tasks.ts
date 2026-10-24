/**
 * `executionCtx.waitUntil` on Node. The Worker runtime keeps an invocation
 * alive until its `waitUntil` promises settle; a process has to do that
 * itself, so every promise is tracked here and a shutdown waits for them.
 */

import type { Logger } from "../logger";

export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly log: Logger) {}

  /** Keep `promise` counted until it settles. A rejection is logged, never rethrown. */
  track(promise: Promise<unknown>): void {
    const tracked: Promise<void> = promise.then(
      () => undefined,
      (error: unknown) => {
        this.log.error("background_task.failed", {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    );
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Wait until every tracked task has settled, including tasks started while
   * waiting, or until `timeoutMs` passes. Returns how many were still running.
   */
  async drain(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      });
      await Promise.race([Promise.allSettled([...this.pending]), expired]);
      clearTimeout(timer);
    }
    return this.pending.size;
  }
}
