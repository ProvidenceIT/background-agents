import { describe, expect, it } from "vitest";
import { modelsForHarness, resolveHarnessModelSelection } from "./session-harness";

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

describe("resolveHarnessModelSelection", () => {
  const ALL = [
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.4",
    "openai/gpt-6-sol",
    "openai/gpt-6.1-sol",
  ] as const;
  const select = (harness: "codex" | "claude", model: string, enabled: readonly string[] = ALL) =>
    resolveHarnessModelSelection({
      harness,
      preference: { model },
      enabledModels: enabled,
      enabledModelOptions: [],
      loading: false,
    }).model;

  it("starts Codex on its own default when the preference cannot run there", () => {
    expect(select("codex", "anthropic/claude-sonnet-4-6")).toBe("openai/gpt-6.1-sol");
  });

  it("keeps a preference Codex can run", () => {
    expect(select("codex", "openai/gpt-6-sol")).toBe("openai/gpt-6-sol");
  });

  it("falls back to the first runnable model when the Codex default is disabled", () => {
    expect(select("codex", "anthropic/claude-sonnet-4-6", ALL.slice(0, 3))).toBe("openai/gpt-5.4");
  });

  it("leaves harnesses without their own default on the catalog default", () => {
    expect(select("claude", "openai/gpt-6.1-sol")).toBe("anthropic/claude-sonnet-4-6");
  });
});
