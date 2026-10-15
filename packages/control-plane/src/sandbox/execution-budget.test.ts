import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "./provider";
import { parseConfiguredExecutionTimeoutMs, resolveExecutionBudgetMs } from "./execution-budget";
import type { Env } from "../types";

describe("parseConfiguredExecutionTimeoutMs", () => {
  it("accepts a positive whole number of milliseconds", () => {
    expect(parseConfiguredExecutionTimeoutMs("14400000")).toBe(14_400_000);
    expect(parseConfiguredExecutionTimeoutMs(" 1000 ")).toBe(1000);
  });

  it.each([undefined, "", "  ", "abc", "1000ms", "0", "-1", "1.5", "NaN", "Infinity"])(
    "rejects %j",
    (raw) => {
      expect(parseConfiguredExecutionTimeoutMs(raw)).toBeUndefined();
    }
  );
});

describe("resolveExecutionBudgetMs", () => {
  it("prefers the scope's sandbox timeout over EXECUTION_TIMEOUT_MS", () => {
    const env = { SANDBOX_PROVIDER: "modal", EXECUTION_TIMEOUT_MS: "14400000" } as Env;

    expect(resolveExecutionBudgetMs({ sandboxTimeoutMs: 3_600_000 }, env)).toBe(3_600_000);
  });

  it("falls back to EXECUTION_TIMEOUT_MS, then the default sandbox lifetime", () => {
    expect(
      resolveExecutionBudgetMs({}, {
        SANDBOX_PROVIDER: "modal",
        EXECUTION_TIMEOUT_MS: "14400000",
      } as Env)
    ).toBe(14_400_000);
    expect(resolveExecutionBudgetMs({}, { SANDBOX_PROVIDER: "modal" } as Env)).toBe(
      DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000
    );
    expect(
      resolveExecutionBudgetMs({}, {
        SANDBOX_PROVIDER: "modal",
        EXECUTION_TIMEOUT_MS: "soon",
      } as Env)
    ).toBe(DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000);
  });

  it("ignores a sandbox timeout the provider cannot honour", () => {
    const env = { SANDBOX_PROVIDER: "daytona", EXECUTION_TIMEOUT_MS: "14400000" } as Env;

    expect(resolveExecutionBudgetMs({ sandboxTimeoutMs: 3_600_000 }, env)).toBe(14_400_000);
  });
});
