import { describe, expect, it } from "vitest";
import { modelsForHarness } from "./session-harness";

const ENABLED = ["openai/gpt-6-sol", "anthropic/claude-sonnet-4-6"] as const;

describe("modelsForHarness", () => {
  it("gives Codex only the OpenAI models and the Claude harness only the Anthropic ones", () => {
    expect(modelsForHarness("codex", ENABLED)).toEqual(["openai/gpt-6-sol"]);
    expect(modelsForHarness("claude", ENABLED)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("gives OpenCode every enabled model", () => {
    expect(modelsForHarness("opencode", ENABLED)).toEqual([...ENABLED]);
  });
});
