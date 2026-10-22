import { describe, expect, it } from "vitest";
import {
  AUTH_HOME_PROVIDER_IDS,
  authHomeProviderForModel,
  AUTH_HOME_REFUSAL_REASONS,
  AUTH_HOME_SELECTION_SOURCES,
  DEFAULT_SUBSCRIPTION_SHARING_POLICY,
  TRIGGER_KINDS,
  authHomeMetadataSchema,
  authHomeOwnerUserId,
  authHomePvcNameSchema,
  authHomeRefusalMessage,
  authHomeResolutionSchema,
  authHomeSchema,
  putAuthHomeRequestSchema,
  subscriptionSharingPolicySchema,
  triggerKindSchema,
} from "./auth-homes";

const home = {
  id: "ah_0123456789abcdef0123456789abcdef",
  ownerUserIds: ["user-1", "user-1-merged"],
  pvcName: "sf-home-bram",
  nodeName: "sandbox-node-1",
  providers: ["anthropic", "openai"],
  kindsEnabled: [...TRIGGER_KINDS],
  backgroundConsentAt: 1_700_000_000_000,
  maxConcurrent: 3,
  shared: true,
  sharingConsentAt: 1_700_000_000_000,
  status: "active",
  claudeExpiresAt: null,
  registeredAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
};

describe("triggerKindSchema", () => {
  it("names the six ways a session starts and nothing else", () => {
    expect(TRIGGER_KINDS).toEqual([
      "prompt",
      "child",
      "mention",
      "issue_label",
      "pr_event",
      "schedule",
    ]);
    expect(triggerKindSchema.parse("mention")).toBe("mention");
    expect(triggerKindSchema.safeParse("api_key").success).toBe(false);
    expect(triggerKindSchema.safeParse("user").success).toBe(false);
  });
});

describe("subscriptionSharingPolicySchema", () => {
  it("defaults to household and accepts only the two policies", () => {
    expect(DEFAULT_SUBSCRIPTION_SHARING_POLICY).toBe("household");
    expect(subscriptionSharingPolicySchema.options).toEqual(["owner_only", "household"]);
    expect(subscriptionSharingPolicySchema.safeParse("everyone").success).toBe(false);
  });
});

describe("authHomeSchema", () => {
  it("accepts a registered home and names its owner", () => {
    expect(authHomeSchema.parse(home)).toEqual(home);
    expect(authHomeOwnerUserId(home)).toBe("user-1");
  });

  it("hides the volume name from administrators", () => {
    const { pvcName: _pvcName, ...metadata } = home;
    expect(authHomeMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(authHomeMetadataSchema.safeParse(home).success).toBe(false);
  });

  it("requires the sf-home- claim prefix and rejects duplicate owners or providers", () => {
    expect(authHomePvcNameSchema.safeParse("sf-home-bram").success).toBe(true);
    expect(authHomePvcNameSchema.safeParse("sf-home-codexer").success).toBe(true);
    for (const name of [
      // A home's Codex claim is derived from the home, never registered as one.
      "sf-home-rob-codex",
      "bram",
      "sf-home-",
      "sf-home-Bram",
      "workspace-abc",
      `sf-home-${"a".repeat(60)}`,
    ]) {
      expect(authHomePvcNameSchema.safeParse(name).success, name).toBe(false);
    }
    expect(authHomeSchema.safeParse({ ...home, ownerUserIds: [] }).success).toBe(false);
    expect(authHomeSchema.safeParse({ ...home, ownerUserIds: ["u", "u"] }).success).toBe(false);
    expect(
      authHomeSchema.safeParse({ ...home, providers: ["anthropic", "anthropic"] }).success
    ).toBe(false);
    expect(authHomeSchema.safeParse({ ...home, providers: ["zhipu"] }).success).toBe(false);
    expect(authHomeSchema.safeParse({ ...home, maxConcurrent: 0 }).success).toBe(false);
  });

  it("carries the Z.AI Coding Plan and Antigravity next to the subscription providers", () => {
    expect(AUTH_HOME_PROVIDER_IDS).toEqual([
      "openai",
      "xai",
      "anthropic",
      "zai-coding-plan",
      "antigravity",
    ]);
    expect(
      authHomeSchema.parse({ ...home, providers: ["anthropic", "zai-coding-plan"] }).providers
    ).toEqual(["anthropic", "zai-coding-plan"]);
  });
});

describe("authHomeProviderForModel", () => {
  it("names the provider a model spends, or null when no home can carry it", () => {
    expect(authHomeProviderForModel("anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(authHomeProviderForModel("zai-coding-plan/glm-5.3")).toBe("zai-coding-plan");
    expect(authHomeProviderForModel("antigravity/gemini-4-argon")).toBe("antigravity");
    expect(authHomeProviderForModel("openai/gpt-6-sol")).toBe("openai");
    expect(authHomeProviderForModel("opencode-go/glm-5.2")).toBeNull();
  });
});

describe("putAuthHomeRequestSchema", () => {
  it("defaults every kind on, consent and sharing off, and never takes an owner", () => {
    expect(
      putAuthHomeRequestSchema.parse({
        pvcName: "sf-home-bram",
        nodeName: "sandbox-node-1",
        providers: ["anthropic"],
      })
    ).toEqual({
      pvcName: "sf-home-bram",
      nodeName: "sandbox-node-1",
      providers: ["anthropic"],
      kindsEnabled: [...TRIGGER_KINDS],
      backgroundConsent: false,
      maxConcurrent: 3,
      shared: false,
      status: "active",
    });
    expect(
      putAuthHomeRequestSchema.safeParse({
        pvcName: "sf-home-bram",
        nodeName: "sandbox-node-1",
        providers: ["anthropic"],
        ownerUserIds: ["someone-else"],
      }).success
    ).toBe(false);
  });
});

describe("authHomeResolutionSchema", () => {
  it("accepts a shared resolution with the home and its owner", () => {
    const shared = { kind: "shared", homeId: home.id, homeOwnerUserId: "user-1" };
    expect(authHomeResolutionSchema.parse(shared)).toEqual(shared);
    expect(
      authHomeResolutionSchema.parse({ kind: "own", homeId: home.id, homeOwnerUserId: "user-1" })
    ).toMatchObject({ kind: "own" });
  });

  it("requires a reason on a refusal and a home on a resolution", () => {
    expect(authHomeResolutionSchema.safeParse({ kind: "refused" }).success).toBe(false);
    expect(authHomeResolutionSchema.parse({ kind: "refused", reason: "no_eligible_home" })).toEqual(
      { kind: "refused", reason: "no_eligible_home" }
    );
    expect(
      authHomeResolutionSchema.safeParse({ kind: "refused", reason: "api_key_fallback" }).success
    ).toBe(false);
    expect(authHomeResolutionSchema.safeParse({ kind: "own", homeId: home.id }).success).toBe(
      false
    );
  });

  it("words every refusal without offering a key", () => {
    for (const reason of AUTH_HOME_REFUSAL_REASONS) {
      const message = authHomeRefusalMessage(reason, "anthropic");
      expect(message).toContain("anthropic");
      expect(message.toLowerCase()).not.toContain("api key");
    }
    expect(authHomeRefusalMessage("no_eligible_home", "anthropic")).toBe(
      "no eligible subscription home for anthropic: enrol one under Settings > Subscription homes, or ask an enrolled colleague to share theirs"
    );
    expect(AUTH_HOME_SELECTION_SOURCES).toEqual({
      own: "auth_home_own",
      shared: "auth_home_shared",
    });
  });
});
