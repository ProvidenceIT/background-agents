import { describe, expect, it } from "vitest";
import type { AuthHomeSeat } from "@open-inspect/shared/types/auth-homes";
import { codexSeatNotice } from "./codex-seat";

function seat(overrides: Partial<AuthHomeSeat> = {}): AuthHomeSeat {
  return {
    homeId: "ah_1",
    seat: "codex",
    holder: {
      sessionId: "S1",
      mine: true,
      acquiredAt: 1,
      heartbeatAt: 1,
      fencing: false,
    },
    waiting: [{ sessionId: "S2", mine: true, position: 1, enqueuedAt: 2 }],
    ...overrides,
  };
}

describe("codexSeatNotice", () => {
  it("tells a waiting session its place", () => {
    expect(codexSeatNotice(seat(), "S2")).toBe("Waiting for your Codex seat (position 1).");
  });

  it("says nothing for the running session or without a home", () => {
    expect(codexSeatNotice(seat(), "S1")).toBeNull();
    expect(codexSeatNotice(null, "S2")).toBeNull();
  });

  it("explains a wait behind a holder that is being fenced", () => {
    const fencing = seat({
      holder: { sessionId: null, mine: false, acquiredAt: 1, heartbeatAt: 1, fencing: true },
    });
    expect(codexSeatNotice(fencing, "S2")).toBe(
      "Waiting for your Codex seat: the previous Codex session stopped responding and is being shut down."
    );
  });

  it("warns a new session that the seat is taken, and by whom", () => {
    expect(codexSeatNotice(seat())).toBe(
      "Your Codex seat is in use by another of your sessions; a new Codex session waits for it."
    );
    expect(
      codexSeatNotice(
        seat({
          holder: { sessionId: null, mine: false, acquiredAt: 1, heartbeatAt: 1, fencing: false },
        })
      )
    ).toBe("Your Codex seat is in use by a colleague's session; a new Codex session waits for it.");
    expect(codexSeatNotice(seat({ holder: null }))).toBeNull();
  });
});
