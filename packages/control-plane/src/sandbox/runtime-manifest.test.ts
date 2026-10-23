import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@open-inspect/shared/harnesses";
import { minCompatibleRuntimeVersionFor } from "../image-builds/model";
import {
  HARNESS_MIN_RUNTIME_GENERATION,
  MIN_REBUILD_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_VERSION,
} from "./runtime-manifest";

describe("sandbox runtime manifest", () => {
  it("names its generation in the runtime version", () => {
    expect(SANDBOX_RUNTIME_VERSION).toMatch(new RegExp(`^v${SANDBOX_RUNTIME_GENERATION}-`));
  });

  it("only floors harnesses the control plane knows, never above the current generation", () => {
    for (const [harness, floor] of Object.entries(HARNESS_MIN_RUNTIME_GENERATION)) {
      expect(HARNESS_IDS).toContain(harness);
      expect(floor).toBeLessThanOrEqual(SANDBOX_RUNTIME_GENERATION);
    }
    expect(MIN_REBUILD_RUNTIME_GENERATION).toBeLessThanOrEqual(SANDBOX_RUNTIME_GENERATION);
  });

  it("keeps grok and agy off images built before their CLIs and harnesses", () => {
    expect(minCompatibleRuntimeVersionFor("grok")).toBe(75);
    expect(minCompatibleRuntimeVersionFor("agy")).toBe(75);
  });
});
