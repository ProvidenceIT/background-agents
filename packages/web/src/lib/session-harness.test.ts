import { describe, expect, it } from "vitest";
import type { ModelCategory } from "@open-inspect/shared/models";
import {
  filterModelOptionsForHarness,
  harnessForModelPick,
  modelsForHarness,
  resolveHarnessModelSelection,
} from "./session-harness";

const ENABLED = ["openai/gpt-6-sol", "anthropic/claude-sonnet-4-6"] as const;

describe("modelsForHarness", () => {
  it("gives Codex only the OpenAI models and the Claude harness only the Anthropic ones", () => {
    expect(modelsForHarness("codex", ENABLED)).toEqual(["openai/gpt-6-sol"]);
    expect(modelsForHarness("claude", ENABLED)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("gives OpenCode every enabled model no other harness is pinned to", () => {
    expect(modelsForHarness("opencode", ENABLED)).toEqual(["openai/gpt-6-sol"]);
  });
});

describe("harnessForModelPick", () => {
  it("switches to the harness a picked model is pinned to", () => {
    expect(harnessForModelPick("opencode", "anthropic/claude-opus-5-5")).toBe("claude");
    expect(harnessForModelPick("codex", "claude-opus-5-5")).toBe("claude");
    expect(harnessForModelPick("opencode", "antigravity/gemini-4-argon")).toBe("agy");
  });

  it("keeps the harness for an unpinned model, even one it cannot run", () => {
    expect(harnessForModelPick("claude", "anthropic/claude-sonnet-4-6")).toBe("claude");
    expect(harnessForModelPick("opencode", "openai/gpt-6-sol")).toBe("opencode");
    expect(harnessForModelPick("claude", "openai/gpt-6-sol")).toBe("claude");
  });
});

describe("filterModelOptionsForHarness", () => {
  const OPTIONS: ModelCategory[] = [
    {
      category: "Anthropic",
      models: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", description: "Best" }],
    },
    {
      category: "Google Antigravity",
      models: [{ id: "antigravity/gemini-4-argon", name: "Gemini 4 Argon", description: "Fast" }],
    },
    {
      category: "OpenAI",
      models: [{ id: "openai/gpt-6-sol", name: "GPT-6 Sol", description: "Smart" }],
    },
  ];
  const ids = (groups: ReturnType<typeof filterModelOptionsForHarness>) =>
    groups.flatMap((group) => group.models.map((model) => `${model.id}: ${model.description}`));

  it("hides models the harness cannot run", () => {
    expect(ids(filterModelOptionsForHarness("opencode", OPTIONS))).toEqual([
      "openai/gpt-6-sol: Smart",
    ]);
  });

  it("labels models pinned to another harness with the harness picking one switches to", () => {
    expect(ids(filterModelOptionsForHarness("opencode", OPTIONS, { switchable: true }))).toEqual([
      "anthropic/claude-opus-5-5: Switches to Claude Agent",
      "antigravity/gemini-4-argon: Switches to Antigravity",
      "openai/gpt-6-sol: Smart",
    ]);
    // Unpinned models another harness could run stay hidden.
    expect(ids(filterModelOptionsForHarness("claude", OPTIONS, { switchable: true }))).toEqual([
      "anthropic/claude-opus-5-5: Best",
      "antigravity/gemini-4-argon: Switches to Antigravity",
    ]);
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

describe("resolveHarnessModelSelection on a session's fixed harness", () => {
  const hold = (harness: "opencode" | "claude", model: string) =>
    resolveHarnessModelSelection({
      harness,
      preference: { model },
      enabledModels: ["openai/gpt-6-sol", "anthropic/claude-sonnet-4-6"],
      enabledModelOptions: [],
      loading: false,
      holdPinnedElsewhere: true,
    }).availability;

  it("holds an OpenCode session on an Anthropic model with the fork hint, not another provider", () => {
    expect(hold("opencode", "anthropic/claude-sonnet-4-6")).toEqual({
      status: "unavailable",
      message:
        "anthropic/claude-sonnet-4-6 runs only on Claude Agent; fork this session onto Claude Agent, or pick another model.",
    });
  });

  it("lets a model the harness runs through", () => {
    expect(hold("opencode", "openai/gpt-6-sol")).toEqual({ status: "available" });
    expect(hold("claude", "anthropic/claude-sonnet-4-6")).toEqual({ status: "available" });
  });
});
