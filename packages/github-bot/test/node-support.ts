/** Fixtures shared by the Node entry tests. */

import { computeHmacHex } from "@open-inspect/shared/auth";
import type { GitHubBotNodeConfig } from "../src/node/config";

export const WEBHOOK_SECRET = "test-webhook-secret";
export const SERVICE_SECRET = "test-service-secret-github-bot";
export const BOT_USERNAME = "test-bot[bot]";

export function nodeConfig(
  stateDir: string,
  overrides: Partial<GitHubBotNodeConfig["vars"]> = {},
  controlPlaneUrl = "http://control-plane.test"
): GitHubBotNodeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    stateDir,
    controlPlaneUrl,
    logLevel: "error",
    vars: {
      DEPLOYMENT_NAME: "test",
      DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
      GITHUB_BOT_USERNAME: BOT_USERNAME,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_APP_INSTALLATION_ID: "2",
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SERVICE_AUTH_SECRET: SERVICE_SECRET,
      SF_GITHUB_REPO_ALLOWLIST: "acme/widgets",
      LOG_LEVEL: "error",
      ...overrides,
    },
  };
}

/** A GitHub webhook request for `payload`, signed with `secret`. */
export async function webhookRequest(
  event: string,
  deliveryId: string,
  payload: unknown,
  secret = WEBHOOK_SECRET
): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request("http://github-bot.test/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "X-Hub-Signature-256": `sha256=${await computeHmacHex(body, secret)}`,
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": deliveryId,
    },
  });
}

const REPOSITORY = { id: 99, name: "widgets", private: true, owner: { login: "acme" } };
const SENDER = {
  id: 7,
  login: "alice",
  type: "User",
  avatar_url: "https://example.com/alice.png",
};

/** `pull_request_review.submitted`: the delivery GitHub sends when a review is submitted. */
export function reviewSubmittedPayload(repository = REPOSITORY) {
  return {
    action: "submitted",
    review: { id: 5678, state: "commented" },
    pull_request: { number: 42 },
    repository,
    sender: SENDER,
  };
}

/** `pull_request_review_comment.created` for a comment that does not mention the bot. */
export function reviewCommentPayload(repository = REPOSITORY) {
  return {
    action: "created",
    pull_request: {
      number: 42,
      title: "Handle nullable input",
      body: null,
      user: { login: "bob", id: 8 },
      head: { ref: "feature/nulls", sha: "abc123" },
      base: { ref: "main" },
    },
    comment: {
      id: 5679,
      body: "Please handle the null case.",
      path: "src/input.ts",
      diff_hunk: "@@ -1 +1 @@",
      user: { login: "alice" },
    },
    repository,
    sender: SENDER,
  };
}
