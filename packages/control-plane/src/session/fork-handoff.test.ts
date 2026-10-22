import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { FORK_HANDOFF_MAX_CHARS } from "@open-inspect/shared/types/session-api";
import {
  buildForkHandoff,
  FORK_CONSENT_LINE,
  forkStartBranch,
  type ForkHandoffSource,
} from "./fork-handoff";

const BASE = { sandboxId: "sb-1", timestamp: 1 };

function source(overrides: Partial<ForkHandoffSource> = {}): ForkHandoffSource {
  return {
    sessionId: "src-1",
    title: "Fix the parser",
    repositories: [],
    lastTurnLimit: null,
    events: [],
    prompts: [],
    promptsTruncated: false,
    ...overrides,
  };
}

describe("forkStartBranch", () => {
  it("starts from the pushed work branch, else the base branch", () => {
    expect(
      forkStartBranch({
        repoOwner: "acme",
        repoName: "web",
        baseBranch: "main",
        branchName: "oi/fix-parser",
      })
    ).toBe("oi/fix-parser");
    expect(
      forkStartBranch({ repoOwner: "acme", repoName: "web", baseBranch: "main", branchName: null })
    ).toBe("main");
  });
});

describe("buildForkHandoff", () => {
  it("drafts the full handoff from a limited session", () => {
    const events: SandboxEvent[] = [
      { ...BASE, type: "user_message", messageId: "m1", content: "Fix the parser" },
      {
        ...BASE,
        type: "tool_call",
        messageId: "m1",
        callId: "c1",
        tool: "TodoWrite",
        args: {
          todos: [
            { content: "Write a failing test", status: "completed" },
            { content: "Fix tokenizer", status: "in_progress" },
          ],
        },
      },
      {
        ...BASE,
        type: "tool_call",
        messageId: "m1",
        callId: "c2",
        tool: "Edit",
        args: { file_path: "src/parser.ts" },
        status: "completed",
      },
      {
        ...BASE,
        type: "tool_call",
        messageId: "m1",
        callId: "c3",
        tool: "Write",
        args: { file_path: "src/parser.test.ts" },
        status: "completed",
      },
      {
        ...BASE,
        type: "tool_call",
        messageId: "m1",
        callId: "c4",
        tool: "Edit",
        args: { file_path: "src/parser.ts" },
        status: "completed",
      },
      { ...BASE, type: "token", messageId: "m1", content: "The tokenizer drops quotes." },
      {
        ...BASE,
        type: "execution_complete",
        messageId: "m2",
        success: false,
        error: "Claude usage limit reached",
      },
    ];

    expect(
      buildForkHandoff(
        source({
          repositories: [
            { repoOwner: "acme", repoName: "web", baseBranch: "main", branchName: "oi/parser" },
            { repoOwner: "acme", repoName: "api", baseBranch: "develop", branchName: null },
          ],
          lastTurnLimit: {
            kind: "subscription_limit",
            window: "five_hour",
            resetsAtMs: Date.UTC(2026, 9, 22, 9, 0, 0),
            subscriptionSlot: "claude-5",
            harness: "claude",
          },
          events,
          prompts: ["Fix the parser", "Also cover\nescaped quotes"],
        })
      )
    ).toBe(
      [
        '# Handoff from "Fix the parser"',
        "",
        "You are continuing the work of another Open Inspect session (src-1) in a new session. The original session stays open. What follows is a summary of its record: treat it as a claim and check the repository before relying on it.",
        "",
        "## Repositories",
        "",
        "- acme/web: starts from `oi/parser`, the branch the original session pushed its work to. Pull requests from this session target `main`, the original base branch.",
        "- acme/api: starts from base branch `develop`. Nothing was pushed, so unpushed work from the original sandbox is not here.",
        "",
        "## Original request",
        "",
        "> Fix the parser",
        "",
        "## Later prompts",
        "",
        "2.",
        "> Also cover",
        "> escaped quotes",
        "",
        "## Plan as last recorded",
        "",
        "- [completed] Write a failing test",
        "- [in_progress] Fix tokenizer",
        "",
        "## Recent assistant messages",
        "",
        "> The tokenizer drops quotes.",
        "",
        "## Where it stopped",
        "",
        "The last turn failed: Claude usage limit reached",
        "The claude subscription limit stopped the last turn (five-hour window, slot claude-5). It resets at 2026-10-22T09:00:00.000Z.",
        "",
        "## Files edited",
        "",
        "- src/parser.ts",
        "- src/parser.test.ts",
        "",
        "## Rules that still apply",
        "",
        FORK_CONSENT_LINE,
        "Start by checking `git status` and `git log` against the summary above, then continue the task.",
      ].join("\n")
    );
  });

  it("drafts a minimal handoff for an empty session", () => {
    expect(buildForkHandoff(source({ title: null }))).toBe(
      [
        '# Handoff from "Untitled session"',
        "",
        "You are continuing the work of another Open Inspect session (src-1) in a new session. The original session stays open. What follows is a summary of its record: treat it as a claim and check the repository before relying on it.",
        "",
        "## Rules that still apply",
        "",
        FORK_CONSENT_LINE,
        "Start by checking `git status` and `git log` against the summary above, then continue the task.",
      ].join("\n")
    );
  });

  it("replays Task tools after the last TodoWrite and keeps the latest copy of a call", () => {
    const handoff = buildForkHandoff(
      source({
        planEvents: [
          {
            ...BASE,
            type: "tool_call",
            messageId: "m1",
            callId: "t1",
            tool: "TaskCreate",
            args: { subject: "Draft" },
            status: "running",
          },
          {
            ...BASE,
            type: "tool_call",
            messageId: "m1",
            callId: "t1",
            tool: "TaskCreate",
            args: { subject: "Draft" },
            status: "completed",
            output: "Task #7 created successfully: Draft",
          },
          {
            ...BASE,
            type: "tool_call",
            messageId: "m1",
            callId: "t2",
            tool: "TaskUpdate",
            args: { taskId: 7, status: "completed", subject: "Draft the fix" },
          },
        ],
      })
    );
    expect(handoff).toContain("## Plan as last recorded\n\n- [completed] Draft the fix\n");
  });

  it("names a limit without slot or reset time", () => {
    const handoff = buildForkHandoff(
      source({
        lastTurnLimit: {
          kind: "subscription_limit",
          window: "unknown",
          resetsAtMs: null,
          subscriptionSlot: null,
          harness: "claude",
        },
      })
    );
    expect(handoff).toContain(
      "## Where it stopped\n\nThe claude subscription limit stopped the last turn (unknown window). The reset time is unknown.\n"
    );
  });

  it("shows the five latest later prompts and labels a partial prompt history", () => {
    const prompts = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const handoff = buildForkHandoff(source({ prompts, promptsTruncated: true }));
    expect(handoff).toContain("## Earliest prompt read\n\n> p1\n");
    expect(handoff).toContain(
      "## Later prompts\n\n(2 earlier prompts omitted.)\n\n4.\n> p4\n\n5.\n> p5\n\n6.\n> p6\n\n7.\n> p7\n\n8.\n> p8\n"
    );
  });

  it("stays within the size limit and keeps the consent rule for a huge session", () => {
    const huge = "x".repeat(30_000);
    const events: SandboxEvent[] = Array.from({ length: 10 }, (_, index) => ({
      ...BASE,
      type: "token" as const,
      messageId: `m${index}`,
      content: huge,
    }));
    const input = source({
      prompts: Array.from({ length: 20 }, () => huge),
      events,
    });

    const handoff = buildForkHandoff(input);

    expect(handoff.length).toBeLessThanOrEqual(FORK_HANDOFF_MAX_CHARS);
    expect(handoff).toContain(FORK_CONSENT_LINE);
    expect(handoff).toContain("…[truncated]");
    expect(buildForkHandoff(input)).toBe(handoff);
  });
});
