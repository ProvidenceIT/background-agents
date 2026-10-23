import { describe, expect, it } from "vitest";
import {
  NOTICE_REASONS,
  agentNoticeSchema,
  renderTeamsAgentNoticeText,
  sanitizeAgentNoticeText,
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

describe("agent notices", () => {
  const hosts = { allowedLinkHosts: ["oi.example.test"] };

  it("strips mentions, markup and links other than this deployment's and GitHub's", () => {
    expect(
      sanitizeAgentNoticeText(
        "<at>Bram</at> @everyone PR ready: https://github.com/acme/widgets/pull/7 see [login](https://evil.example/x) and http://oi.example.test/a www.evil.example <b>now</b>",
        hosts
      )
    ).toBe(
      "everyone PR ready: https://github.com/acme/widgets/pull/7 see login and [link removed] [link removed] now"
    );
    expect(sanitizeAgentNoticeText("[session](https://oi.example.test/session/1)", hosts)).toBe(
      "session https://oi.example.test/session/1"
    );
    expect(sanitizeAgentNoticeText("mail me at a@b.example", hosts)).toBe("mail me at a@b.example");
  });

  it("sees through zero-width characters hidden in links and mentions", () => {
    const none = { allowedLinkHosts: [] };
    expect(sanitizeAgentNoticeText("see ht​tps://evil.example/x now", none)).toBe(
      "see [link removed] now"
    );
    expect(sanitizeAgentNoticeText("see w​ww.evil.example now", none)).toBe(
      "see [link removed] now"
    );
    expect(sanitizeAgentNoticeText("@​everyone hi", none)).toBe("everyone hi");
    expect(sanitizeAgentNoticeText("＠everyone hi", none)).toBe("everyone hi");
    // Removing one piece of markup must not assemble another.
    expect(sanitizeAgentNoticeText("@<b></b>@everyone h<i>ttps://evil.example", none)).toBe(
      "everyone [link removed]"
    );
  });

  it("removes scheme-less links to hosts outside the allowlist", () => {
    expect(sanitizeAgentNoticeText("Re-auth needed: evil-login.example/oi", hosts)).toBe(
      "Re-auth needed: [link removed]"
    );
    expect(sanitizeAgentNoticeText("go to login-providenceit.com now", hosts)).toBe(
      "go to [link removed] now"
    );
    expect(sanitizeAgentNoticeText("try 10.0.0.1/reset or evil.sh:8080/x", hosts)).toBe(
      "try [link removed] or [link removed]"
    );
    expect(sanitizeAgentNoticeText("ftp://evil.example/x", hosts)).toBe("[link removed]");
    expect(sanitizeAgentNoticeText("open oi.example.test/session/1", hosts)).toBe(
      "open oi.example.test/session/1"
    );
    expect(sanitizeAgentNoticeText("open github.com/acme/widgets/pull/7", hosts)).toBe(
      "open github.com/acme/widgets/pull/7"
    );
  });

  it("keeps file names, paths and file:line references", () => {
    expect(
      sanitizeAgentNoticeText(
        "Fixed notices.ts:186 and packages/shared/src/notices.ts, see README.md and v1.2.3",
        hosts
      )
    ).toBe("Fixed notices.ts:186 and packages/shared/src/notices.ts, see README.md and v1.2.3");
  });

  it("collapses whitespace and control characters and caps the length", () => {
    expect(sanitizeAgentNoticeText("a​\u0007b\n\n\n  c   d  ", hosts)).toBe("ab\nc d");
    expect(sanitizeAgentNoticeText("x".repeat(900), hosts)).toHaveLength(500);
    expect(sanitizeAgentNoticeText("<at>x</at> ", hosts)).toBe("");
  });

  it("is closed: no recipient, no title, and the text is optional", () => {
    const notice = {
      kind: "agent",
      sessionId: "s1",
      repo: "acme/widgets",
      urgency: "normal",
      textSha256: "0".repeat(64),
      textLength: 3,
    };
    expect(agentNoticeSchema.safeParse(notice).success).toBe(true);
    expect(agentNoticeSchema.safeParse({ ...notice, title: "Acme" }).success).toBe(false);
    expect(agentNoticeSchema.safeParse({ ...notice, recipient: "x" }).success).toBe(false);
  });

  it("renders who it is from, the words and the session link", () => {
    expect(
      renderTeamsAgentNoticeText(
        {
          kind: "agent",
          sessionId: "s1",
          repo: "acme/widgets",
          urgency: "high",
          text: "Blocked on the API key.",
          textSha256: "0".repeat(64),
          textLength: 23,
        },
        { webAppUrl: "https://oi.example.test/" }
      )
    ).toBe(
      [
        "From your Open-Inspect agent in acme/widgets (needs you):",
        "Blocked on the API key.",
        "https://oi.example.test/session/s1",
      ].join("\n")
    );
  });
});
