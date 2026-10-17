import { describe, expect, it } from "vitest";
import { isOptInService, OPT_IN_SERVICES, serviceAllowsPermission } from "./service-permissions";

describe("serviceAllowsPermission", () => {
  it("allows launch capabilities but denies management capabilities", () => {
    expect(serviceAllowsPermission("slack-bot", "sessions.create")).toBe(true);
    expect(serviceAllowsPermission("linear-bot", "integrations.read")).toBe(true);
    expect(serviceAllowsPermission("slack-bot", "global_secrets.manage")).toBe(false);
    expect(serviceAllowsPermission("github-bot", "sessions.sandbox_access")).toBe(false);
    expect(serviceAllowsPermission("teams-bot", "sessions.create")).toBe(true);
    expect(serviceAllowsPermission("teams-bot", "sessions.sandbox_access")).toBe(false);
    expect(serviceAllowsPermission("teams-bot", "automations.read")).toBe(false);
  });

  it("caps motion at creating, reading, prompting and stopping sessions", () => {
    for (const permission of [
      "sessions.create",
      "sessions.read",
      "sessions.collaborate",
      "sessions.lifecycle",
      "repositories.use",
      "environments.use",
    ] as const) {
      expect(serviceAllowsPermission("motion", permission)).toBe(true);
    }
    for (const permission of [
      "sessions.export",
      "sessions.sandbox_access",
      "sessions.delete",
      "repositories.read",
      "environments.read",
      "integrations.read",
      "skills.read",
      "automations.read",
    ] as const) {
      expect(serviceAllowsPermission("motion", permission)).toBe(false);
    }
  });

  it("caps prompt-library at reading and managing skills", () => {
    for (const permission of ["skills.read", "skills.manage"] as const) {
      expect(serviceAllowsPermission("prompt-library", permission)).toBe(true);
    }
    for (const permission of [
      "skill_profiles.manage_own",
      "sessions.create",
      "sessions.read",
      "repositories.read",
      "repositories.use",
      "environments.read",
      "environments.use",
      "integrations.read",
      "automations.read",
    ] as const) {
      expect(serviceAllowsPermission("prompt-library", permission)).toBe(false);
    }
  });

  it("does not let any other service manage skills", () => {
    for (const service of [
      "web",
      "slack-bot",
      "github-bot",
      "linear-bot",
      "teams-bot",
      "motion",
    ] as const) {
      expect(serviceAllowsPermission(service, "skills.manage")).toBe(false);
    }
  });

  it("lists motion and prompt-library, and only those, as opt-in services", () => {
    expect(OPT_IN_SERVICES).toEqual(["motion", "prompt-library"]);
    expect(isOptInService("motion")).toBe(true);
    expect(isOptInService("prompt-library")).toBe(true);
    for (const service of ["web", "slack-bot", "github-bot", "linear-bot", "teams-bot"] as const) {
      expect(isOptInService(service)).toBe(false);
    }
  });

  it("does not grant bulk export to bot services", () => {
    for (const service of ["github-bot", "slack-bot", "linear-bot", "teams-bot"] as const) {
      expect(serviceAllowsPermission(service, "sessions.export")).toBe(false);
    }
  });
});
