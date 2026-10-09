import { describe, expect, it } from "vitest";
import { reportedClaudeExpiresAt } from "./claude-expiry";

const EXPIRY = Date.UTC(2027, 9, 9, 10, 30);

describe("reportedClaudeExpiresAt", () => {
  it("reads the enrolment script's ISO 8601 value and integers in seconds or milliseconds", () => {
    expect(reportedClaudeExpiresAt({ claude_expires_at: "2027-10-09T10:30:00Z" })).toBe(EXPIRY);
    expect(reportedClaudeExpiresAt({ claude_expires_at: EXPIRY / 1000 })).toBe(EXPIRY);
    expect(reportedClaudeExpiresAt({ claude_expires_at: String(EXPIRY / 1000) })).toBe(EXPIRY);
    expect(reportedClaudeExpiresAt({ claude_expires_at: EXPIRY })).toBe(EXPIRY);
  });

  it("is null for a missing report, a missing file and anything that is not a timestamp", () => {
    expect(reportedClaudeExpiresAt(undefined)).toBeNull();
    expect(reportedClaudeExpiresAt({ claude_expires_at: null })).toBeNull();
    expect(reportedClaudeExpiresAt({})).toBeNull();
    expect(reportedClaudeExpiresAt({ claude_expires_at: "next year" })).toBeNull();
    expect(reportedClaudeExpiresAt({ claude_expires_at: -5 })).toBeNull();
    expect(reportedClaudeExpiresAt({ claude_expires_at: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
