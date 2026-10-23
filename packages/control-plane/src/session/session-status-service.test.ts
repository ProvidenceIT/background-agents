import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createLogger } from "../logger";
import { createMockSession } from "../sandbox/lifecycle/test-helpers";
import type { ArtifactRepository } from "./artifact-repository";
import type { MessageRepository } from "./message-repository";
import type { SessionRuntimeClient } from "./runtime-client";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionMessenger } from "./messenger";
import { SessionStatusService } from "./session-status-service";

function harness() {
  const repository = {
    getSession: () => createMockSession(),
    updateSessionStatus: vi.fn(),
  };
  const statusProjection = { project: vi.fn(async () => true) };
  const notices = { settled: vi.fn() };
  const service = new SessionStatusService(
    createTestBackgroundTasks(),
    createLogger("control-plane"),
    repository as unknown as SessionCoreRepository,
    {} as MessageRepository,
    {} as ArtifactRepository,
    { getSessionTotals: vi.fn() },
    { broadcast: vi.fn(), sendToSandbox: vi.fn() } as SessionMessenger,
    { finalizeChildAdmission: vi.fn(), updateMetrics: vi.fn() },
    statusProjection,
    { fetch: vi.fn() } as SessionRuntimeClient,
    () => {},
    notices
  );
  return { service, repository, statusProjection, notices };
}

describe("SessionStatusService.transition", () => {
  it("keeps local write failures as promise rejections", async () => {
    const h = harness();
    h.repository.updateSessionStatus.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    await expect(h.service.transition("archived")).rejects.toThrow("local status write failed");
    expect(h.statusProjection.project).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.beginTransition", () => {
  it("throws a local write failure synchronously without starting projection", () => {
    const h = harness();
    h.repository.updateSessionStatus.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    expect(() => h.service.beginTransition("archived")).toThrow("local status write failed");
    expect(h.statusProjection.project).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService session notices", () => {
  it("hands each status change to the notice recorder with its revision and time", async () => {
    // The mock session is stamped with the clock; a frozen one keeps it equal across calls.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    try {
      const h = harness();
      const session = createMockSession();

      await h.service.transition("completed");

      expect(h.notices.settled).toHaveBeenCalledTimes(1);
      expect(h.notices.settled).toHaveBeenCalledWith(
        session,
        session.session_name || session.id,
        "completed",
        session.status_revision + 1,
        Math.max(Date.now(), session.updated_at + 1)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises no notice when the status did not change", async () => {
    const h = harness();

    await h.service.transition(createMockSession().status);

    expect(h.notices.settled).not.toHaveBeenCalled();
  });
});
