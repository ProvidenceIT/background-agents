import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob";

describe("matchGlob", () => {
  it("matches ** followed by a slash only at segment boundaries", () => {
    expect(matchGlob("**/auth/**", "auth/login.ts")).toBe(true);
    expect(matchGlob("**/auth/**", "src/auth/login.ts")).toBe(true);
    expect(matchGlob("**/auth/**", "src/oauth/login.ts")).toBe(false);
    expect(matchGlob("a/**/b", "a/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/x/y/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/xb")).toBe(false);
  });

  it("keeps * within one segment and a trailing ** across segments", () => {
    expect(matchGlob("release/*", "release/1.2")).toBe(true);
    expect(matchGlob("release/*", "release/1/2")).toBe(false);
    expect(matchGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchGlob("**/*.sql", "schema.sql")).toBe(true);
    expect(matchGlob("**/*.sql", "db/0001_init.sql")).toBe(true);
  });
});
