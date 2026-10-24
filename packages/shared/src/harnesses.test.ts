import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS,
  HARNESS_CATALOG,
  HARNESS_IDS,
  assessRunnability,
  checkHarnessCompatibility,
  filterModelsForHarness,
  getValidHarnessOrDefault,
  MODEL_PROVIDER_HARNESS,
  harnessForModel,
  harnessSupportsModel,
  harnessSupportsProviderAuth,
  isValidHarness,
  selectedProviderAuthModes,
  reconcileProviderSelectionsForHarness,
  resolveHarnessForModel,
} from "./harnesses";
import { VALID_MODELS } from "./models";

describe("harness catalog", () => {
  it("lists only harnesses the runtime can boot, built-in first", () => {
    expect(HARNESS_IDS).toEqual(["opencode", "claude", "codex", "grok", "agy"]);
    expect(DEFAULT_HARNESS).toBe("opencode");
  });

  it("never brands the Claude harness as Claude Code", () => {
    expect(HARNESS_CATALOG.claude.label).toBe("Claude Agent");
  });

  it("runs Codex on OpenAI models from a subscription home only", () => {
    expect(HARNESS_CATALOG.codex).toEqual({
      label: "Codex",
      defaultModel: "openai/gpt-6.1-sol",
      modelFamilies: ["openai"],
      providerAuth: { openai: ["auth_home"] },
      resume: "session_id",
    });
  });

  it("runs SuperGrok and Antigravity from a subscription home only", () => {
    expect(HARNESS_CATALOG.grok).toMatchObject({
      label: "SuperGrok",
      modelFamilies: ["xai"],
      defaultModel: "xai/grok-4.7-build-fast",
      providerAuth: { xai: ["auth_home"] },
    });
    expect(HARNESS_CATALOG.agy).toMatchObject({
      label: "Antigravity",
      modelFamilies: ["antigravity"],
      defaultModel: "antigravity/gemini-4-argon",
      providerAuth: { antigravity: ["auth_home"] },
    });
  });

  it("pins Anthropic to Claude Agent and Antigravity to agy", () => {
    expect(MODEL_PROVIDER_HARNESS).toEqual({ anthropic: "claude", antigravity: "agy" });
  });

  it("starts every harness with a default model it can run", () => {
    for (const harness of HARNESS_IDS) {
      const model = (HARNESS_CATALOG[harness] as { defaultModel?: string }).defaultModel;
      if (model) {
        expect(VALID_MODELS).toContain(model);
        expect(harnessSupportsModel(harness, model)).toBe(true);
      }
    }
  });

  it("resolves an absent or unknown harness to the default", () => {
    expect(getValidHarnessOrDefault(undefined)).toBe("opencode");
    expect(getValidHarnessOrDefault(null)).toBe("opencode");
    expect(getValidHarnessOrDefault("pi")).toBe("opencode");
    expect(getValidHarnessOrDefault("codex")).toBe("codex");
    expect(getValidHarnessOrDefault("claude")).toBe("claude");
    expect(isValidHarness("claude")).toBe(true);
    expect(isValidHarness("codex")).toBe(true);
    expect(isValidHarness("pi")).toBe(false);
    expect(isValidHarness(42)).toBe(false);
  });
});

describe("harnessSupportsModel", () => {
  it("lets OpenCode run every catalog model outside a pinned provider", () => {
    for (const model of VALID_MODELS) {
      const pinned = model.startsWith("anthropic/") || model.startsWith("antigravity/");
      expect(harnessSupportsModel("opencode", model)).toBe(!pinned);
    }
    expect(harnessSupportsModel("opencode", "xai/grok-4.7")).toBe(true);
    expect(harnessSupportsModel("opencode", "openai/gpt-6.1-sol")).toBe(true);
  });

  it("refuses Anthropic models, prefixed or bare, on every harness but Claude Agent", () => {
    for (const harness of HARNESS_IDS) {
      expect(harnessSupportsModel(harness, "anthropic/claude-opus-5-5")).toBe(harness === "claude");
      expect(harnessSupportsModel(harness, "claude-sonnet-4-6")).toBe(harness === "claude");
    }
  });

  it("restricts SuperGrok to the models the grok CLI lists", () => {
    expect(harnessSupportsModel("grok", "xai/grok-4.7-build-fast")).toBe(true);
    expect(harnessSupportsModel("grok", "xai/grok-4.7")).toBe(true);
    expect(harnessSupportsModel("grok", "xai/grok-build-0.1")).toBe(false);
    expect(harnessSupportsModel("grok", "openai/gpt-6.1-sol")).toBe(false);
    expect(harnessSupportsModel("grok", "anthropic/claude-opus-5-5")).toBe(false);
  });

  it("restricts Antigravity to Antigravity models", () => {
    expect(harnessSupportsModel("agy", "antigravity/gemini-4-argon")).toBe(true);
    expect(harnessSupportsModel("agy", "anthropic/claude-opus-5-5")).toBe(false);
    expect(harnessSupportsModel("agy", "claude-sonnet-4-6")).toBe(false);
    expect(harnessSupportsModel("agy", "openai/gpt-6.1-sol")).toBe(false);
    expect(harnessSupportsModel("agy", "xai/grok-4.7")).toBe(false);
  });

  it("catalogs no Claude model behind Antigravity", () => {
    expect(VALID_MODELS.filter((model) => model.startsWith("antigravity/claude"))).toEqual([]);
  });

  it("restricts the Claude harness to Anthropic models", () => {
    expect(harnessSupportsModel("claude", "anthropic/claude-sonnet-4-6")).toBe(true);
    expect(harnessSupportsModel("claude", "claude-sonnet-4-6")).toBe(true);
    expect(harnessSupportsModel("claude", "openai/gpt-5.5")).toBe(false);
    expect(harnessSupportsModel("claude", "xai/grok-4.6")).toBe(false);
  });

  it("restricts the Codex harness to OpenAI models", () => {
    expect(harnessSupportsModel("codex", "openai/gpt-6-sol")).toBe(true);
    expect(harnessSupportsModel("codex", "anthropic/claude-sonnet-4-6")).toBe(false);
    expect(harnessSupportsModel("codex", "xai/grok-4.6")).toBe(false);
    expect(
      filterModelsForHarness("codex", ["openai/gpt-6-sol", "anthropic/claude-sonnet-4-6"])
    ).toEqual(["openai/gpt-6-sol"]);
  });

  it("filters a model list by harness", () => {
    const filtered = filterModelsForHarness("claude", VALID_MODELS);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((model) => model.startsWith("anthropic/"))).toBe(true);
    expect(filterModelsForHarness("opencode", VALID_MODELS)).toEqual(
      VALID_MODELS.filter(
        (model) => !model.startsWith("anthropic/") && !model.startsWith("antigravity/")
      )
    );
  });
});

describe("harnessForModel", () => {
  it("runs a pinned provider on its harness and everything else on the built-in harness", () => {
    expect(harnessForModel("anthropic/x")).toBe("claude");
    expect(harnessForModel("claude-sonnet-4-6")).toBe("claude");
    expect(harnessForModel("antigravity/gemini-4-argon")).toBe("agy");
    expect(harnessForModel("xai/grok-4.7")).toBe("opencode");
    expect(harnessForModel("openai/gpt-6.1-sol")).toBe("opencode");
  });
});

describe("resolveHarnessForModel", () => {
  it("keeps the configured harness when it can run the model", () => {
    expect(resolveHarnessForModel("claude", "anthropic/claude-sonnet-4-6")).toBe("claude");
    expect(resolveHarnessForModel("opencode", "openai/gpt-5.5")).toBe("opencode");
  });

  it("keeps Codex for an OpenAI model and falls back to the model's harness otherwise", () => {
    expect(resolveHarnessForModel("codex", "openai/gpt-6-sol")).toBe("codex");
    expect(resolveHarnessForModel("codex", "anthropic/x")).toBe("claude");
    expect(resolveHarnessForModel("codex", "xai/grok-4.7")).toBe(DEFAULT_HARNESS);
  });

  it("moves a pinned model off OpenCode", () => {
    expect(resolveHarnessForModel("opencode", "anthropic/claude-sonnet-4-6")).toBe("claude");
    expect(resolveHarnessForModel("grok", "antigravity/gemini-4-argon")).toBe("agy");
  });

  it("falls back to the built-in harness for a model the configured harness cannot run", () => {
    expect(resolveHarnessForModel("claude", "openai/gpt-5.5")).toBe(DEFAULT_HARNESS);
    expect(resolveHarnessForModel("claude", "xai/grok-4.6")).toBe(DEFAULT_HARNESS);
  });

  it("resolves an unconfigured harness to the model's harness", () => {
    expect(resolveHarnessForModel(undefined, "anthropic/x")).toBe("claude");
    for (const model of VALID_MODELS) {
      expect(resolveHarnessForModel(undefined, model)).toBe(harnessForModel(model));
    }
  });
});

describe("harnessSupportsProviderAuth", () => {
  it("passes resolver-assigned legacy mode through on every harness", () => {
    expect(harnessSupportsProviderAuth("opencode", "openai", "legacy_scoped_oauth")).toBe(true);
    expect(harnessSupportsProviderAuth("claude", "anthropic", "legacy_scoped_oauth")).toBe(true);
    expect(harnessSupportsProviderAuth("claude", "openai", "legacy_scoped_oauth")).toBe(true);
  });

  it("does not pass legacy mode through where the harness runs the provider only on a home", () => {
    expect(harnessSupportsProviderAuth("codex", "openai", "legacy_scoped_oauth")).toBe(false);
    expect(harnessSupportsProviderAuth("codex", "openai", "auth_home")).toBe(true);
    expect(
      checkHarnessCompatibility("codex", "openai/gpt-6-sol", { openai: "legacy_scoped_oauth" })
    ).toMatchObject({ code: "provider_auth" });
  });

  it("selects Anthropic auth on the Claude harness only", () => {
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "api_key")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "auth_home")).toBe(false);
    expect(harnessSupportsProviderAuth("claude", "anthropic", "provider_account")).toBe(true);
  });

  it("runs SuperGrok and Antigravity only on a subscription home", () => {
    expect(harnessSupportsProviderAuth("grok", "xai", "auth_home")).toBe(true);
    expect(harnessSupportsProviderAuth("grok", "xai", "api_key")).toBe(false);
    expect(harnessSupportsProviderAuth("grok", "xai", "legacy_scoped_oauth")).toBe(false);
    expect(harnessSupportsProviderAuth("agy", "antigravity", "auth_home")).toBe(true);
    expect(harnessSupportsProviderAuth("agy", "antigravity", "api_key")).toBe(false);
  });

  it("keeps OpenAI and xAI provider accounts on OpenCode", () => {
    expect(harnessSupportsProviderAuth("opencode", "openai", "provider_account")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "xai", "provider_account")).toBe(true);
  });

  it("runs xAI on a subscription home only through SuperGrok", () => {
    // The home holds a pushed SuperGrok token that only the grok CLI reads.
    expect(harnessSupportsProviderAuth("opencode", "xai", "auth_home")).toBe(false);
    expect(checkHarnessCompatibility("opencode", "xai/grok-4.7", { xai: "auth_home" })).toEqual({
      code: "provider_auth",
      message:
        "The OpenCode harness cannot run xai on a subscription home; use the SuperGrok harness.",
    });
    expect(checkHarnessCompatibility("grok", "xai/grok-4.7", { xai: "auth_home" })).toBeNull();
  });

  it("lets OpenCode run every xAI model on a key, the SuperGrok defaults included", () => {
    expect(harnessSupportsModel("opencode", "xai/grok-4.7-build-fast")).toBe(true);
  });

  it("selects no auth mode for a provider the harness has no row for", () => {
    expect(harnessSupportsProviderAuth("claude", "openai", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("claude", "openai", "api_key")).toBe(false);
    expect(harnessSupportsProviderAuth("claude", "xai", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "google", "api_key")).toBe(false);
  });
});

describe("reconcileProviderSelectionsForHarness", () => {
  const account = { mode: "provider_account" as const, accountId: "a".repeat(32) };

  it("drops a selection the harness runs the provider without", () => {
    expect(
      reconcileProviderSelectionsForHarness("codex", { openai: account, xai: account })
    ).toEqual({ xai: account });
  });

  it("keeps selections for providers the harness does not run", () => {
    const selections = { openai: account, xai: { mode: "api_key" as const } };
    expect(reconcileProviderSelectionsForHarness("claude", selections)).toBe(selections);
  });

  it("returns the same object when every selection is usable", () => {
    const selections = { anthropic: account };
    expect(reconcileProviderSelectionsForHarness("claude", selections)).toBe(selections);
    const anthropic = { anthropic: account };
    expect(reconcileProviderSelectionsForHarness("opencode", anthropic)).toBe(anthropic);
  });
});

describe("selectedProviderAuthModes", () => {
  it("maps explicit selections to their modes and skips absent providers", () => {
    expect(
      selectedProviderAuthModes({
        openai: { mode: "provider_account", accountId: "0123456789abcdef0123456789abcdef" },
        xai: { mode: "api_key" },
      })
    ).toEqual({ openai: "provider_account", xai: "api_key" });
    expect(selectedProviderAuthModes({ openai: undefined })).toEqual({});
  });
});

describe("checkHarnessCompatibility", () => {
  it("accepts a compatible harness, model and auth", () => {
    expect(checkHarnessCompatibility("opencode", "openai/gpt-6.1-sol")).toBeNull();
    expect(
      checkHarnessCompatibility("grok", "xai/grok-4.7-build-fast", { xai: "auth_home" })
    ).toBeNull();
    expect(
      checkHarnessCompatibility("claude", "anthropic/claude-sonnet-4-6", {
        anthropic: "provider_account",
        openai: "provider_account",
      })
    ).toBeNull();
  });

  it("rejects a model the harness cannot run", () => {
    const result = checkHarnessCompatibility("claude", "openai/gpt-5.5");
    expect(result?.code).toBe("model");
    expect(result?.message).toContain("Claude Agent");
  });

  it("points an Anthropic model on another harness to Claude Agent", () => {
    expect(checkHarnessCompatibility("opencode", "anthropic/claude-sonnet-4-6")).toEqual({
      code: "model",
      message:
        'Model "anthropic/claude-sonnet-4-6" cannot run on the OpenCode harness. It runs only on Claude Agent; fork this session onto Claude Agent.',
    });
  });

  it("rejects an auth mode the harness cannot select for the model's provider", () => {
    const result = checkHarnessCompatibility("opencode", "deepseek/deepseek-v4-pro", {
      deepseek: "provider_account",
    });
    expect(result?.code).toBe("provider_auth");
    expect(result?.message).toContain("API key");
    const grok = checkHarnessCompatibility("grok", "xai/grok-4.7", { xai: "provider_account" });
    expect(grok?.code).toBe("provider_auth");
    expect(grok?.message).toContain("subscription home");
  });

  it("ignores auth modes for providers the model does not use", () => {
    expect(
      checkHarnessCompatibility("opencode", "openai/gpt-5.5", {
        anthropic: "provider_account",
        openai: "api_key",
      })
    ).toBeNull();
  });

  it("runs Codex on an OpenAI model bound to a subscription home", () => {
    expect(
      checkHarnessCompatibility("codex", "openai/gpt-6-sol", { openai: "auth_home" })
    ).toBeNull();
  });

  it("refuses Codex on a model outside OpenAI", () => {
    expect(checkHarnessCompatibility("codex", "anthropic/claude-sonnet-4-6")).toEqual({
      code: "model",
      message:
        'Model "anthropic/claude-sonnet-4-6" cannot run on the Codex harness. It runs only on Claude Agent; fork this session onto Claude Agent.',
    });
    expect(checkHarnessCompatibility("codex", "xai/grok-4.7")).toEqual({
      code: "model",
      message: 'Model "xai/grok-4.7" cannot run on the Codex harness.',
    });
  });

  it("refuses Codex on an OpenAI key or connected account", () => {
    const expected = {
      code: "provider_auth",
      message:
        "The Codex harness runs openai only on a subscription home; enrol one under Settings > Subscription homes.",
    };
    expect(checkHarnessCompatibility("codex", "openai/gpt-6-sol", { openai: "api_key" })).toEqual(
      expected
    );
    expect(
      checkHarnessCompatibility("codex", "openai/gpt-6-sol", { openai: "provider_account" })
    ).toEqual(expected);
  });
});

describe("assessRunnability", () => {
  it("refuses OpenCode + a Claude model on a Claude subscription home as a payer mismatch", () => {
    expect(
      assessRunnability("opencode", "anthropic/claude-haiku-4-5", { anthropic: "auth_home" })
    ).toEqual({
      runnable: false,
      payer: "none",
      reasons: [
        {
          code: "payer_mismatch",
          message:
            "The OpenCode harness cannot run anthropic on a subscription home; use the Claude Agent harness.",
        },
        {
          code: "model_unsupported",
          message:
            'Model "anthropic/claude-haiku-4-5" cannot run on the OpenCode harness. It runs only on Claude Agent; fork this session onto Claude Agent.',
        },
      ],
    });
  });

  it("treats a bare Claude id on OpenCode the same way", () => {
    expect(
      assessRunnability("opencode", "claude-haiku-4-5", { anthropic: "auth_home" }).reasons[0]?.code
    ).toBe("payer_mismatch");
  });

  it("runs a Claude model on Claude Agent paid by the subscription home", () => {
    expect(
      assessRunnability("claude", "anthropic/claude-haiku-4-5", { anthropic: "auth_home" })
    ).toEqual({ runnable: true, payer: "subscription", reasons: [] });
  });

  it("names the payer for each selectable mode", () => {
    expect(
      assessRunnability("claude", "anthropic/claude-haiku-4-5", { anthropic: "provider_account" })
        .payer
    ).toBe("provider_account");
    expect(
      assessRunnability("claude", "anthropic/claude-haiku-4-5", { anthropic: "api_key" }).payer
    ).toBe("api_key");
    expect(
      assessRunnability("opencode", "openai/gpt-6.1-sol", { openai: "legacy_scoped_oauth" }).payer
    ).toBe("api_key");
  });

  it("refuses Codex on an OpenAI API key", () => {
    expect(assessRunnability("codex", "openai/gpt-6.1-sol", { openai: "api_key" })).toEqual({
      runnable: false,
      payer: "none",
      reasons: [
        {
          code: "payer_mismatch",
          message:
            "The Codex harness runs openai only on a subscription home; enrol one under Settings > Subscription homes.",
        },
      ],
    });
  });

  it("leaves an unbound provider to the run, except where only a home can pay", () => {
    expect(assessRunnability("claude", "anthropic/claude-haiku-4-5")).toEqual({
      runnable: true,
      payer: "none",
      reasons: [],
    });
    expect(assessRunnability("codex", "openai/gpt-6.1-sol")).toEqual({
      runnable: true,
      payer: "subscription",
      reasons: [],
    });
  });

  it("does not judge a provider the harness pays outside the selectable modes", () => {
    expect(
      assessRunnability("opencode", "zai-coding-plan/glm-5.3", { "zai-coding-plan": "api_key" })
    ).toEqual({ runnable: true, payer: "api_key", reasons: [] });
  });

  it("reports a model the harness cannot run without a binding", () => {
    expect(assessRunnability("grok", "xai/grok-build-0.1")).toEqual({
      runnable: false,
      payer: "none",
      reasons: [
        {
          code: "model_unsupported",
          message: 'Model "xai/grok-build-0.1" cannot run on the SuperGrok harness.',
        },
      ],
    });
  });
});
