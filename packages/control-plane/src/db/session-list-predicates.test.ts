import { describe, expect, it } from "vitest";
import { buildSessionListPredicates } from "./session-list-predicates";

describe("buildSessionListPredicates", () => {
  it("binds a service's external ref lookup to the service, ref and owner", () => {
    const { where, params } = buildSessionListPredicates({
      externalRef: { service: "motion", ref: "wi-123:1", ownerUserId: "user-1" },
      readScope: { kind: "internal", reason: "test" },
      mode: "off",
    });

    expect(where).toContain("external_ref_service = ? AND external_ref = ? AND user_id = ?");
    expect(params).toEqual(["motion", "wi-123:1", "user-1"]);
  });

  it("adds no external ref condition without the filter", () => {
    const { where } = buildSessionListPredicates({
      readScope: { kind: "internal", reason: "test" },
      mode: "off",
    });

    expect(where).not.toContain("external_ref");
  });
});
