import { describe, expect, it } from "vitest";
import {
  createSessionInputSchema,
  createSessionRequestSchema,
  linearCallbackContextSchema,
  linearCompletionCallbackSchema,
  linearStartCallbackSchema,
  linearToolCallCallbackSchema,
  sendPromptRequestSchema,
  sessionExternalRefSchema,
} from "./session-api";

const legacyContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

describe("Linear callback channel context", () => {
  it.each([false, true])(
    "preserves the external team with transitionIssueOnStart=%s",
    (transitionIssueOnStart) => {
      const context = {
        ...legacyContext,
        organizationId: "org-1",
        appUserId: "app-user-1",
        transitionIssueOnStart,
        linearTeamId: "external-team-1",
      };

      expect(linearCallbackContextSchema.parse(context)).toEqual(context);
      const callback = {
        sessionId: "session-1",
        messageId: "message-1",
        timestamp: 123,
        signature: "signature",
        context,
      };
      expect(linearStartCallbackSchema.parse(callback).context.linearTeamId).toBe(
        "external-team-1"
      );
      expect(
        linearCompletionCallbackSchema.parse({ ...callback, success: true }).context.linearTeamId
      ).toBe("external-team-1");
      expect(
        linearToolCallCallbackSchema.parse({
          sessionId: "session-1",
          timestamp: 123,
          signature: "signature",
          context,
          tool: "bash",
          args: {},
          callId: "call-1",
        }).context.linearTeamId
      ).toBe("external-team-1");
    }
  );

  it("accepts persisted contexts that predate linearTeamId", () => {
    expect(linearCallbackContextSchema.parse(legacyContext)).toEqual(legacyContext);
    expect(
      linearCompletionCallbackSchema.safeParse({
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: 123,
        signature: "signature",
        context: legacyContext,
      }).success
    ).toBe(true);
  });

  it.each(["", " \t ", null, 123])("rejects an invalid external team ID: %s", (linearTeamId) => {
    expect(linearCallbackContextSchema.safeParse({ ...legacyContext, linearTeamId }).success).toBe(
      false
    );
  });

  it("does not accept an internal owner teamId as callback channel context", () => {
    expect(
      linearCallbackContextSchema.safeParse({ ...legacyContext, teamId: "internal-team-1" }).success
    ).toBe(false);
  });
});

describe("session creation trigger fields", () => {
  const body = {
    repoOwner: "acme",
    repoName: "widgets",
    triggerKind: "issue_label",
    workItemAuthorScmUserId: "63718501",
  };

  it("carries the trigger kind and work-item author on the service input only", () => {
    expect(createSessionInputSchema.parse(body)).toMatchObject({
      triggerKind: "issue_label",
      workItemAuthorScmUserId: "63718501",
    });
    expect(createSessionInputSchema.safeParse({ ...body, triggerKind: "user" }).success).toBe(
      false
    );
    const publicBody = createSessionRequestSchema.parse(body);
    expect(publicBody).not.toHaveProperty("triggerKind");
    expect(publicBody).not.toHaveProperty("workItemAuthorScmUserId");
  });
});

describe("service idempotency keys", () => {
  it.each(["wi-123:1", "a", "Providence/work-item@42.retry_1", "x".repeat(200)])(
    "accepts %s",
    (ref) => {
      expect(sessionExternalRefSchema.safeParse(ref).success).toBe(true);
    }
  );

  it.each(["", "x".repeat(201), "has space", "-leading", ".leading", "wi\u00e9", "a\nb", "a#b"])(
    "rejects %j",
    (ref) => {
      expect(sessionExternalRefSchema.safeParse(ref).success).toBe(false);
    }
  );

  it("carries externalRef on the service create input and strips it from the public request", () => {
    const body = { repoOwner: "acme", repoName: "widgets", externalRef: "wi-123:1" };
    expect(createSessionInputSchema.parse(body)).toMatchObject({ externalRef: "wi-123:1" });
    expect(createSessionInputSchema.safeParse({ ...body, externalRef: "bad ref" }).success).toBe(
      false
    );
    expect(createSessionRequestSchema.parse(body)).not.toHaveProperty("externalRef");
  });

  it("validates a prompt's clientRequestId with the same rule", () => {
    expect(
      sendPromptRequestSchema.parse({ content: "go", clientRequestId: "wi-123:prompt-1" })
    ).toMatchObject({ clientRequestId: "wi-123:prompt-1" });
    expect(
      sendPromptRequestSchema.safeParse({ content: "go", clientRequestId: "bad key" }).success
    ).toBe(false);
  });
});
