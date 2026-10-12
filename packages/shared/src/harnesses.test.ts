import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS,
  HARNESS_CATALOG,
  HARNESS_IDS,
  checkHarnessCompatibility,
  filterModelsForHarness,
  getValidHarnessOrDefault,
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
    expect(HARNESS_IDS).toEqual(["opencode", "claude", "codex"]);
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
  it("lets OpenCode run every catalog model", () => {
    for (const model of VALID_MODELS) {
      expect(harnessSupportsModel("opencode", model)).toBe(true);
    }
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
    expect(filterModelsForHarness("opencode", VALID_MODELS)).toEqual([...VALID_MODELS]);
  });
});

describe("resolveHarnessForModel", () => {
  it("keeps the configured harness when it can run the model", () => {
    expect(resolveHarnessForModel("claude", "anthropic/claude-sonnet-4-6")).toBe("claude");
    expect(resolveHarnessForModel("opencode", "openai/gpt-5.5")).toBe("opencode");
  });

  it("keeps Codex for an OpenAI model and falls back to the built-in harness otherwise", () => {
    expect(resolveHarnessForModel("codex", "openai/gpt-6-sol")).toBe("codex");
    expect(resolveHarnessForModel("codex", "anthropic/claude-sonnet-4-6")).toBe("opencode");
  });

  it("falls back to the built-in harness for a model the configured harness cannot run", () => {
    expect(resolveHarnessForModel("claude", "openai/gpt-5.5")).toBe(DEFAULT_HARNESS);
    expect(resolveHarnessForModel("claude", "xai/grok-4.6")).toBe(DEFAULT_HARNESS);
  });

  it("resolves an unconfigured harness to the built-in harness for every model", () => {
    for (const model of VALID_MODELS) {
      expect(resolveHarnessForModel(undefined, model)).toBe(DEFAULT_HARNESS);
    }
  });
});

describe("harnessSupportsProviderAuth", () => {
  it("passes resolver-assigned legacy mode through on every harness", () => {
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "legacy_scoped_oauth")).toBe(true);
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

  it("only the Claude harness may select an Anthropic provider account", () => {
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "api_key")).toBe(true);
    expect(harnessSupportsProviderAuth("claude", "anthropic", "provider_account")).toBe(true);
  });

  it("keeps OpenAI and xAI provider accounts on OpenCode", () => {
    expect(harnessSupportsProviderAuth("opencode", "openai", "provider_account")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "xai", "provider_account")).toBe(true);
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
      reconcileProviderSelectionsForHarness("opencode", { anthropic: account, openai: account })
    ).toEqual({ openai: account });
  });

  it("keeps selections for providers the harness does not run", () => {
    const selections = { openai: account, xai: { mode: "api_key" as const } };
    expect(reconcileProviderSelectionsForHarness("claude", selections)).toBe(selections);
  });

  it("returns the same object when every selection is usable", () => {
    const selections = { anthropic: account };
    expect(reconcileProviderSelectionsForHarness("claude", selections)).toBe(selections);
    expect(
      reconcileProviderSelectionsForHarness("opencode", { anthropic: { mode: "api_key" } })
    ).toEqual({ anthropic: { mode: "api_key" } });
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
    expect(checkHarnessCompatibility("opencode", "anthropic/claude-sonnet-4-6")).toBeNull();
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

  it("rejects an auth mode the harness cannot select for the model's provider", () => {
    const result = checkHarnessCompatibility("opencode", "anthropic/claude-sonnet-4-6", {
      anthropic: "provider_account",
    });
    expect(result?.code).toBe("provider_auth");
    expect(result?.message).toContain("API key");
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
      message: 'Model "anthropic/claude-sonnet-4-6" cannot run on the Codex harness.',
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
