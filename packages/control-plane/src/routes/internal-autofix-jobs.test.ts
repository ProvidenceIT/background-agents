import { describe, expect, it } from "vitest";
import type { Job } from "../jobs";
import {
  createTestEnv,
  createTestRequestHandler,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { catalog } from "./catalog";
import { GITHUB_AUTOFIX_JOB_PATH, internalAutofixJobRoutes } from "./internal-autofix-jobs";

const URL_BASE = "https://control-plane.test";

const ENVELOPE = {
  version: 1,
  eventType: "pull_request_review",
  action: "submitted",
  deliveryId: "delivery-review-1",
  providerObject: { kind: "review", id: "555" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-10-24T08:00:00.000Z",
} as const;

const handleRequest = createTestRequestHandler([internalAutofixJobRoutes]);

function envRecordingJobs(): { env: ReturnType<typeof createTestEnv>; sent: Job[] } {
  const sent: Job[] = [];
  const env = createTestEnv({
    ...TEST_SERVICE_SECRETS,
    JOBS: {
      send: async (job) => {
        sent.push(job);
      },
    },
  });
  return { env, sent };
}

async function post(
  body: string,
  service: "github-bot" | "slack-bot" = "github-bot"
): Promise<Request> {
  return signedServiceRequest(`${URL_BASE}${GITHUB_AUTOFIX_JOB_PATH}`, {
    method: "POST",
    body,
    service,
  });
}

describe("POST /internal/jobs/github.autofix", () => {
  it("is registered in the production catalog", () => {
    expect(catalog).toContain(internalAutofixJobRoutes);
  });

  it("enqueues a valid envelope from github-bot as one github.autofix job", async () => {
    const { env, sent } = envRecordingJobs();

    const response = await handleRequest(
      await post(JSON.stringify(ENVELOPE)),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
    expect(sent).toEqual([{ kind: "github.autofix", payload: ENVELOPE }]);
  });

  it("rejects an envelope that does not match the schema without enqueueing", async () => {
    const { env, sent } = envRecordingJobs();

    const response = await handleRequest(
      await post(JSON.stringify({ ...ENVELOPE, pullRequestNumber: 0 })),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const { env, sent } = envRecordingJobs();

    const response = await handleRequest(await post("{"), env, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(sent).toEqual([]);
  });

  it("answers 404 for any other job kind", async () => {
    const { env, sent } = envRecordingJobs();
    const request = await signedServiceRequest(`${URL_BASE}/internal/jobs/image_build.finalize`, {
      method: "POST",
      body: JSON.stringify(ENVELOPE),
      service: "github-bot",
    });

    const response = await handleRequest(request, env, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("refuses another service", async () => {
    const { env, sent } = envRecordingJobs();

    const response = await handleRequest(
      await post(JSON.stringify(ENVELOPE), "slack-bot"),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("refuses an unsigned request", async () => {
    const { env, sent } = envRecordingJobs();

    const response = await handleRequest(
      new Request(`${URL_BASE}${GITHUB_AUTOFIX_JOB_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ENVELOPE),
      }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });
});
