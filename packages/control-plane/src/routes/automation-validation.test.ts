import { describe, expect, it } from "vitest";
import { validateAutomationRunnability } from "./automation-validation";

describe("validateAutomationRunnability", () => {
  it("passes a setup that can run", () => {
    expect(validateAutomationRunnability("claude", "anthropic/claude-haiku-4-5")).toBeNull();
    expect(
      validateAutomationRunnability("claude", "anthropic/claude-haiku-4-5", {
        anthropic: "provider_account",
      })
    ).toBeNull();
  });

  it("answers 422 listing every reason for OpenCode + a Claude model on a Claude account", async () => {
    const response = validateAutomationRunnability("opencode", "anthropic/claude-haiku-4-5", {
      anthropic: "provider_account",
    });
    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({
      error:
        "The OpenCode harness cannot use anthropic credentials; use the Claude Agent harness. " +
        'Model "anthropic/claude-haiku-4-5" cannot run on the OpenCode harness. It runs only on Claude Agent; fork this session onto Claude Agent.',
      code: "not_runnable",
      reasons: [
        {
          code: "payer_mismatch",
          message:
            "The OpenCode harness cannot use anthropic credentials; use the Claude Agent harness.",
        },
        {
          code: "model_unsupported",
          message:
            'Model "anthropic/claude-haiku-4-5" cannot run on the OpenCode harness. It runs only on Claude Agent; fork this session onto Claude Agent.',
        },
      ],
    });
  });

  it("answers 422 for a harness that runs the provider only on a home, pinned to an API key", async () => {
    const response = validateAutomationRunnability("grok", "xai/grok-4.7", { xai: "api_key" });
    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toMatchObject({
      code: "not_runnable",
      reasons: [{ code: "payer_mismatch" }],
    });
  });
});
