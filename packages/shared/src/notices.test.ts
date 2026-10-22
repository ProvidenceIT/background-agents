import { describe, expect, it } from "vitest";
import {
  NOTICE_REASONS,
  noticeEnvelopeSchema,
  renderTeamsNoticeText,
  type NoticeEnvelope,
} from "./notices";

const BASE: NoticeEnvelope = {
  sessionId: "9f2c4e1a7b3d5f60a1b2c3d4e5f60718",
  status: "completed",
  reason: "completed",
  repo: "acme/widgets",
  prNumber: null,
  prUrl: null,
  activeDurationMs: 12 * 60 * 1000,
  resetsAtMs: null,
};

describe("noticeEnvelopeSchema", () => {
  it("accepts the closed shape", () => {
    expect(noticeEnvelopeSchema.parse(BASE)).toEqual(BASE);
  });

  it("rejects any field outside the closed shape", () => {
    for (const extra of ["title", "prompt", "error", "cost", "text"]) {
      expect(noticeEnvelopeSchema.safeParse({ ...BASE, [extra]: "x" }).success).toBe(false);
    }
  });

  it("only knows the narrow reason taxonomy", () => {
    expect(NOTICE_REASONS).toEqual(["completed", "failed", "limit_hit", "recovery_needed"]);
    expect(noticeEnvelopeSchema.safeParse({ ...BASE, reason: "archived" }).success).toBe(false);
  });

  it("only carries terminal turn statuses", () => {
    for (const status of ["active", "created", "archived", "cancelled"]) {
      expect(noticeEnvelopeSchema.safeParse({ ...BASE, status }).success).toBe(false);
    }
  });

  it("refuses a non-https pull request link", () => {
    expect(
      noticeEnvelopeSchema.safeParse({ ...BASE, prNumber: 4, prUrl: "javascript:alert(1)" }).success
    ).toBe(false);
  });
});

describe("renderTeamsNoticeText", () => {
  it("says what finished, where, and links the session", () => {
    const text = renderTeamsNoticeText(
      { ...BASE, prNumber: 42, prUrl: "https://github.com/acme/widgets/pull/42" },
      { webAppUrl: "https://oi.example.test/" }
    );
    expect(text).toContain("completed");
    expect(text).toContain("acme/widgets");
    expect(text).toContain("PR #42: https://github.com/acme/widgets/pull/42");
    expect(text).toContain("12 min");
    expect(text).toContain("https://oi.example.test/session/9f2c4e1a7b3d5f60a1b2c3d4e5f60718");
  });

  it("omits the link without a web app URL", () => {
    expect(renderTeamsNoticeText(BASE, {})).not.toContain("http");
  });

  it("names the reset time of a usage limit", () => {
    const text = renderTeamsNoticeText(
      {
        ...BASE,
        status: "failed",
        reason: "limit_hit",
        resetsAtMs: Date.UTC(2026, 9, 23, 14, 5),
      },
      {}
    );
    expect(text).toContain("usage limit");
    expect(text).toContain("2026-10-23 14:05 UTC");
  });

  it("asks for recovery when the sandbox is held", () => {
    expect(
      renderTeamsNoticeText({ ...BASE, status: "failed", reason: "recovery_needed" }, {})
    ).toContain("recovery");
  });

  it("works for a session without a repository", () => {
    expect(renderTeamsNoticeText({ ...BASE, repo: null }, {})).not.toContain("null");
  });
});
