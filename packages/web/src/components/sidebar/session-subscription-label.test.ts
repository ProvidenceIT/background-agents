import { describe, expect, it } from "vitest";
import type { SessionSubscription } from "@open-inspect/shared/types/session-subscription";
import {
  describeSessionSubscription,
  describeSubscriptionSlots,
} from "./session-subscription-label";

const base: SessionSubscription = {
  provider: "anthropic",
  authMode: "auth_home",
  holder: "you",
  shared: false,
  holderUserId: "user-1",
  holderDisplayName: "Ada",
  accountDisplayName: null,
  payer: "subscription",
  slots: [],
};

describe("describeSessionSubscription", () => {
  it.each<[Partial<SessionSubscription>, string]>([
    [{}, "Your Claude subscription"],
    [{ holder: "colleague", shared: true }, "Ada's shared Claude subscription"],
    [
      { holder: "colleague", shared: true, holderUserId: null, holderDisplayName: null },
      "A colleague's shared Claude subscription",
    ],
    [
      { provider: "openai", authMode: "provider_account", accountDisplayName: "Team Pro" },
      "Your ChatGPT subscription (Team Pro)",
    ],
    [{ holder: "workspace", authMode: "api_key", holderUserId: null }, "Workspace Claude API key"],
    [
      { provider: "zai-coding-plan", holder: "colleague", shared: true },
      "Ada's shared Z.AI Coding Plan subscription",
    ],
    [
      { holder: "workspace", authMode: "legacy_scoped_oauth", holderUserId: null },
      "Workspace Claude credentials",
    ],
    [{ payer: "none" }, "None: this agent cannot use your Claude subscription"],
    [
      { payer: "none", holder: "colleague", shared: true },
      "None: this agent cannot use Ada's shared Claude subscription",
    ],
  ])("describes %o as %s", (overrides, label) => {
    expect(describeSessionSubscription({ ...base, ...overrides })).toBe(label);
  });
});

describe("describeSubscriptionSlots", () => {
  const slot = (name: string, turns: number) => ({
    slot: name,
    turns,
    inputTokens: null,
    outputTokens: null,
    lastUsedAt: 1,
  });

  it("names the one slot, or each slot with its turns", () => {
    expect(describeSubscriptionSlots([])).toBeNull();
    expect(describeSubscriptionSlots([slot("claude-3", 4)])).toBe("claude-3");
    expect(describeSubscriptionSlots([slot("claude-3", 4), slot("claude-7", 1)])).toBe(
      "claude-3 · 4 turns, claude-7 · 1 turn"
    );
  });
});
